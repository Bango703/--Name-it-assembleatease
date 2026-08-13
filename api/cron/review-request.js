import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail } from '../_email.js';
import { issueReviewToken } from '../_review-token.js';
import { buildReviewEmail, completionPhotoUrl, bookingsWithOpenCase } from '../_review-email.js';

// Up-to-3 spaced review requests. The customer gets a first ask, then at most two
// gentle follow-ups — but ONLY while no review has been logged AND no dispute/case
// is open. As soon as a row exists in `reviews` for the booking, the sequence
// stops. Requests are spaced, never back-to-back. The owner can always override
// and send manually (api/review-request.js), even during a dispute.
const FIRST_DELAY_DAYS = 2;      // request #1: 2 days after completion
const FOLLOWUP_GAPS    = [3, 4]; // #2: 3 days after #1  ·  #3: 4 days after #2  (→ ~day 2 / 5 / 9)
const MAX_REQUESTS     = 3;
const MAX_AGE_DAYS     = 30;     // stop chasing a booking older than this

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const now = Date.now();

  // Candidates: completed within the age window, not yet at the request cap.
  const { data: bookings, error } = await sb
    .from('bookings')
    .select('id, ref, service, customer_email, completed_at, review_requested_at, review_request_count, assembler_id, assembler_name, job_started_at, evidence_requested_at, source, payment_status, status, return_visit_required')
    .eq('status', 'completed')
    .gte('completed_at', new Date(now - MAX_AGE_DAYS * 86400000).toISOString())
    .or(`review_request_count.is.null,review_request_count.lt.${MAX_REQUESTS}`)
    .limit(100);

  if (error) {
    console.error('Review request cron error:', error);
    return res.status(500).json({ error: 'Query failed' });
  }
  if (!bookings || !bookings.length) {
    return res.status(200).json({ sent: 0, message: 'No bookings need review requests' });
  }

  const ids = bookings.map((b) => b.id);

  // One batched lookup: which of these bookings already have a review? Those stop.
  const { data: reviewRows, error: revErr } = await sb
    .from('reviews')
    .select('booking_id')
    .in('booking_id', ids);
  if (revErr) {
    console.error('Review lookup error:', revErr);
    return res.status(500).json({ error: 'Review lookup failed' });
  }
  const reviewed = new Set((reviewRows || []).map((r) => r.booking_id));

  // Which bookings have an OPEN dispute/damage/case? Never auto-ask for a public
  // review mid-dispute. null = the lookup failed → skip this whole run (fail safe).
  const openCase = await bookingsWithOpenCase(sb, ids);
  if (openCase === null) {
    return res.status(200).json({ sent: 0, skipped: 'open_case_lookup_failed' });
  }

  let sent = 0;
  const breakdown = { 1: 0, 2: 0, 3: 0 };

  for (const b of bookings) {
    try {
      if (reviewed.has(b.id)) continue;               // customer already reviewed → stop
      if (openCase.has(b.id)) continue;               // open dispute/case → owner handles it
      if (b.return_visit_required === true) continue; // work isn't truly finished — don't ask yet
      if (!b.customer_email) continue;

      // How many have we already sent? (fall back to review_requested_at for rows
      // that predate the counter column.)
      const count = Number(b.review_request_count ?? (b.review_requested_at ? 1 : 0));
      if (count >= MAX_REQUESTS) continue;

      const lastSent = b.review_requested_at ? new Date(b.review_requested_at).getTime() : null;
      let due;
      if (count === 0) {
        due = new Date(b.completed_at).getTime() <= now - FIRST_DELAY_DAYS * 86400000;
      } else {
        const gapDays = FOLLOWUP_GAPS[count - 1];   // count 1 → 3 days, count 2 → 4 days
        due = lastSent != null && lastSent <= now - gapDays * 86400000;
      }
      if (!due) continue;

      const step = count + 1;                        // 1, 2, or 3
      const reviewToken = issueReviewToken({ bookingId: b.id, ref: b.ref, email: b.customer_email });
      const url = `https://www.assembleatease.com/review?ref=${encodeURIComponent(b.ref)}&email=${encodeURIComponent(b.customer_email)}&token=${encodeURIComponent(reviewToken)}`;
      const photoUrl = await completionPhotoUrl(sb, b);
      const proFirst = (b.assembler_name || '').split(' ')[0] || '';
      const { subject, html } = buildReviewEmail(step, b, url, { photoUrl, proFirst });

      const emailResult = await sendEmail({
        to: b.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject,
        html,
        replyTo: ownerEmail(),
        meta: {
          bookingId: b.id,
          notificationType: `review_request_${step}`,
          recipientType: 'customer',
          disableDedupe: true,   // each of the 3 is a distinct, intentional send
        },
      });
      if (!emailResult?.ok) throw new Error(emailResult?.error || 'Review email delivery failed');

      const { error: updErr } = await sb
        .from('bookings')
        .update({ review_requested_at: new Date().toISOString(), review_request_count: step })
        .eq('id', b.id);
      if (updErr) throw updErr;

      sent++;
      breakdown[step]++;
    } catch (err) {
      console.error('Review email error for ' + b.ref + ':', err);
    }
  }

  return res.status(200).json({ sent, breakdown, candidates: bookings.length });
}
