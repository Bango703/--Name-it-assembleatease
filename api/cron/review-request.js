import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const REVIEW_DELAY_DAYS = 2; // days after completion to send review request

export default async function handler(req, res) {
  // Verify cron secret (Vercel sends this header for cron jobs)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const cutoff = new Date(Date.now() - REVIEW_DELAY_DAYS * 86400000).toISOString();

  // Find completed bookings where:
  // 1. completed_at is older than REVIEW_DELAY_DAYS
  // 2. review_requested_at is null (not yet sent)
  const { data: bookings, error } = await sb
    .from('bookings')
    .select('*')
    .eq('status', 'completed')
    .is('review_requested_at', null)
    .lt('completed_at', cutoff)
    .limit(20);

  if (error) {
    console.error('Review request cron error:', error);
    return res.status(500).json({ error: 'Query failed' });
  }

  if (!bookings || !bookings.length) {
    return res.status(200).json({ sent: 0, message: 'No bookings need review requests' });
  }

  const reviewUrl = process.env.GOOGLE_REVIEW_URL || 'https://www.assembleatease.com';
  let sent = 0;

  for (const b of bookings) {
    try {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">How was your experience, ${esc(b.customer_name)}?</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">We hope you loved your <strong>${esc(b.service)}</strong> service! Your feedback helps us keep improving and helps other customers find us.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td style="background:#1d9e75;border-radius:8px;padding:0"><a href="${esc(reviewUrl)}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px">Leave a Google Review &#11088;</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">It only takes a minute and means the world to us. Thank you for choosing AssembleAtEase!</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    Ref: ${esc(b.ref)} &bull; AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;

      await sendEmail({
        to: b.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'How was your experience? Leave a review!',
        html,
        replyTo: ownerEmail(),
      });

      // Mark as sent
      await sb
        .from('bookings')
        .update({ review_requested_at: new Date().toISOString() })
        .eq('id', b.id);

      sent++;
    } catch (err) {
      console.error('Review email error for ' + b.ref + ':', err);
    }
  }

  return res.status(200).json({ sent, total: bookings.length });
}
