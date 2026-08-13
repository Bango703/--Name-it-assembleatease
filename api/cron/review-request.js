import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { issueReviewToken } from '../_review-token.js';
import { loadCurrentCompletionEvidence } from '../booking/_completion-evidence.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

// Up-to-3 spaced review requests. The customer gets a first ask, then at most two
// gentle follow-ups — but ONLY while no review has been logged. As soon as a row
// exists in `reviews` for the booking, the sequence stops (never nag someone who
// already reviewed). Requests are spaced, never back-to-back.
const FIRST_DELAY_DAYS = 2;      // request #1: 2 days after completion
const FOLLOWUP_GAPS    = [3, 4]; // #2: 3 days after #1  ·  #3: 4 days after #2  (→ ~day 2 / 5 / 9)
const MAX_REQUESTS     = 3;
const MAX_AGE_DAYS     = 30;     // stop chasing a booking older than this

// The three escalating-but-respectful variants. Step is 1-based. intro(b, pro).
const STEP_COPY = {
  1: {
    subject: (b) => `How did your ${b.service} go? — ${b.ref}`,
    headline: 'How was your experience?',
    intro: (b, pro) => `Your <strong>${esc(b.service)}</strong>${pro ? ` with ${esc(pro)}` : ''} is complete. Tap a star below to rate it — your booking details are already filled in.`,
    note: `Not happy with something? Just reply to this email within 48 hours and we&rsquo;ll make it right.`,
  },
  2: {
    subject: (b) => `Quick favor — rate your ${b.service}?`,
    headline: 'Still have 30 seconds?',
    intro: (b, pro) => `We&rsquo;d still love to hear how your <strong>${esc(b.service)}</strong>${pro ? ` with ${esc(pro)}` : ''} went. It takes about 30 seconds — just tap a star below.`,
    note: `Something not right? Reply here and we&rsquo;ll take care of it.`,
  },
  3: {
    subject: (b) => `Last chance to rate your ${b.service}`,
    headline: 'One last ask',
    intro: (b, pro) => `This is the last time we&rsquo;ll ask &mdash; promise. A quick rating of your <strong>${esc(b.service)}</strong> helps ${pro ? esc(pro) : 'your pro'} and other Texas neighbors know what to expect. One tap is all it takes.`,
    note: `Prefer not to? No problem &mdash; you won&rsquo;t hear from us about this again.`,
  },
};

// Clickable in-email star rating — each star deep-links to the review page with the
// rating pre-selected, so a single tap from the inbox starts the review.
function starRow(url) {
  let cells = '';
  for (let n = 1; n <= 5; n++) {
    cells += `<td style="padding:0 3px"><a href="${url}&rating=${n}" style="display:inline-block;font-size:40px;line-height:1;color:#f5b301;text-decoration:none" aria-label="${n} star${n > 1 ? 's' : ''}">&#9733;</a></td>`;
  }
  return `<table cellpadding="0" cellspacing="0" align="center" style="margin:2px auto"><tr>${cells}</tr></table>`;
}

// The Easer's completion photo — visual proof of the finished work, so the customer
// sees exactly what they're rating right in the email.
function photoBlock(url, service) {
  if (!url) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151">Here&rsquo;s the ${esc(service)} your pro completed:</p>
    <img src="${url}" alt="Completed ${esc(service)}" style="width:100%;max-width:520px;border-radius:10px;border:1px solid #e4e4e7;display:block"/>
  </td></tr></table>`;
}

function buildReviewEmail(step, b, url, { photoUrl, proFirst } = {}) {
  const c = STEP_COPY[step];
  const headline = (step === 1 && proFirst) ? `How did ${esc(proFirst)} do?` : c.headline;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">${headline}</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">${c.intro(b, proFirst)}</p>
    ${photoBlock(photoUrl, b.service)}
    <p style="margin:0 0 2px;font-size:13px;font-weight:600;color:#374151;text-align:center">Tap a star to rate</p>
    ${starRow(url)}
    <p style="margin:14px 0 0;text-align:center"><a href="${url}" style="font-size:13px;color:#0369a1;text-decoration:underline">or write a full review &rsaquo;</a></p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;margin:20px 0 16px"><tr><td style="padding:12px 16px;font-size:13px;color:#0c4a6e;line-height:1.6">
      ${c.note}
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Thank you for choosing AssembleAtEase.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    Ref: ${esc(b.ref)} &bull; AssembleAtEase &bull; Serving customers across Texas
  </td></tr></table>
</div></body></html>`;
  return { subject: c.subject(b), html };
}

async function completionPhotoUrl(sb, b) {
  try {
    const { evidence } = await loadCurrentCompletionEvidence(sb, b, { allowHistoricalOwnerManual: true });
    if (!evidence?.storage_path) return null;
    const { data: signed } = await sb.storage
      .from('booking-evidence')
      .createSignedUrl(evidence.storage_path, 60 * 60 * 24 * 30);
    return signed?.signedUrl || null;
  } catch {
    return null;
  }
}

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

  // One batched lookup: which of these bookings already have a review? Those stop.
  const ids = bookings.map((b) => b.id);
  const { data: reviewRows, error: revErr } = await sb
    .from('reviews')
    .select('booking_id')
    .in('booking_id', ids);
  if (revErr) {
    console.error('Review lookup error:', revErr);
    return res.status(500).json({ error: 'Review lookup failed' });
  }
  const reviewed = new Set((reviewRows || []).map((r) => r.booking_id));

  let sent = 0;
  const breakdown = { 1: 0, 2: 0, 3: 0 };

  for (const b of bookings) {
    try {
      if (reviewed.has(b.id)) continue;             // customer already reviewed → stop the sequence
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
