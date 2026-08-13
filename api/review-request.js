import { getSupabase } from './_supabase.js';
import { verifyOwner, sendEmail, ownerEmail } from './_email.js';
import { issueReviewToken } from './_review-token.js';
import { buildReviewEmail, completionPhotoUrl } from './_review-email.js';
import { logActivity } from './booking/_activity.js';

// Owner-triggered manual review request ("Request Review" / "Resend Review Request"
// in the dashboard). Deliberately OVERRIDES the automatic suppressions: the owner
// can send even during an open dispute — that's the intended manual escape hatch.
// Uses the same upgraded email (clickable stars + completion photo + pro name) as
// the cron, via the shared api/_review-email.js builder.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const bookingId = String(payload.bookingId || '').trim();
  const resend = payload.resend === true;
  const ownerAcknowledged = payload.ownerAcknowledged === true;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: b, error } = await sb
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .single();

  if (error || !b) return res.status(404).json({ error: 'Booking not found' });
  if (b.status !== 'completed') return res.status(400).json({ error: 'Booking must be completed before requesting a review' });
  if (!b.customer_email) return res.status(400).json({ error: 'No customer email on this booking' });
  if (b.review_requested_at && (!resend || !ownerAcknowledged)) {
    return res.status(409).json({
      error: 'A review request was already sent. Confirm the resend from the owner dashboard before sending another email.',
      code: 'REVIEW_RESEND_CONFIRMATION_REQUIRED',
    });
  }

  let reviewToken;
  try {
    reviewToken = issueReviewToken({ bookingId: b.id, ref: b.ref, email: b.customer_email });
  } catch (tokenError) {
    console.error('Review request token error:', tokenError?.message || tokenError);
    return res.status(503).json({ error: 'Secure review links are not configured. No review email was sent.' });
  }
  const reviewUrl = `https://www.assembleatease.com/review?ref=${encodeURIComponent(b.ref)}&email=${encodeURIComponent(b.customer_email)}&token=${encodeURIComponent(reviewToken)}`;

  const photoUrl = await completionPhotoUrl(sb, b);
  const proFirst = (b.assembler_name || '').split(' ')[0] || '';
  const { subject, html } = buildReviewEmail(1, b, reviewUrl, { photoUrl, proFirst });

  const result = await sendEmail({
    to:      b.customer_email,
    from:    'AssembleAtEase <booking@assembleatease.com>',
    subject,
    html,
    replyTo: ownerEmail(),
    meta:    { bookingId, notificationType: 'review_request', recipientType: 'customer', disableDedupe: resend },
  });

  if (!result.ok || result.suppressed === true) {
    console.error('Review request send error:', result.error);
    return res.status(500).json({ error: 'Review email delivery was not accepted. Nothing was marked sent.' });
  }

  // Mark as sent AND advance the shared counter so the automatic cron treats this as
  // a completed step (never re-sends step 1 on top of a manual send).
  const sentAt = new Date().toISOString();
  const nextCount = Math.min(Number(b.review_request_count || 0) + 1, 3);
  const { error: updateError } = await sb
    .from('bookings')
    .update({ review_requested_at: sentAt, review_request_count: nextCount })
    .eq('id', b.id);
  await logActivity(sb, {
    bookingId: b.id,
    eventType: resend ? 'review_request_resent' : 'review_request_sent',
    actorType: 'owner',
    actorName: 'Owner',
    description: resend
      ? 'Customer review request resent from the owner dashboard.'
      : 'Customer review request sent from the owner dashboard.',
    metadata: { customerEmail: b.customer_email, sentAt, trackingUpdated: !updateError },
  }).catch(activityError => console.warn('Review request activity log skipped:', activityError?.message || activityError));

  return res.status(200).json({
    success: true,
    resent: resend,
    trackingUpdated: !updateError,
    warning: updateError ? 'The email was sent, but the booking timestamp could not be updated.' : null,
  });
}
