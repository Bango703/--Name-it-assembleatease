import { getSupabase } from './_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from './_email.js';
import { issueReviewToken } from './_review-token.js';
import { logActivity } from './booking/_activity.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

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

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">How was your experience?</p>
    <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(b.service)}</strong> service is complete.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Your secure booking details are already filled in. Select a rating and share any feedback about the service.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px"><tr><td style="background:#00BFFF;border-radius:8px"><a href="${reviewUrl}" style="display:inline-block;padding:16px 40px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:8px">Leave Your Review</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6;text-align:center">Thank you for choosing AssembleAtEase.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    Ref: ${esc(b.ref)} &bull; AssembleAtEase &bull; Serving customers across Texas
  </td></tr></table>
</div></body></html>`;

  const result = await sendEmail({
    to:      b.customer_email,
    from:    'AssembleAtEase <booking@assembleatease.com>',
    subject: `Review your completed service — ${b.ref}`,
    html,
    replyTo: ownerEmail(),
    meta:    { bookingId, notificationType: 'review_request', recipientType: 'customer', disableDedupe: resend },
  });

  if (!result.ok || result.suppressed === true) {
    console.error('Review request send error:', result.error);
    return res.status(500).json({ error: 'Review email delivery was not accepted. Nothing was marked sent.' });
  }

  // Mark as sent so the cron doesn't double-send
  const sentAt = new Date().toISOString();
  const { error: updateError } = await sb
    .from('bookings')
    .update({ review_requested_at: sentAt })
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
