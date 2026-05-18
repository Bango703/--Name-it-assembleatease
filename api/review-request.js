import { getSupabase } from './_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from './_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId } = req.body;
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

  const reviewUrl = `https://www.assembleatease.com/review?ref=${encodeURIComponent(b.ref)}&email=${encodeURIComponent(b.customer_email)}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">How was your experience?</p>
    <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.7">We hope you loved your <strong>${esc(b.service)}</strong> service!</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Your booking is already filled in — just click below, pick your stars, and write a couple words. Takes less than a minute.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px"><tr><td style="background:#0097a7;border-radius:8px"><a href="${reviewUrl}" style="display:inline-block;padding:16px 40px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:8px">Leave Your Review &#11088;</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6;text-align:center">Thank you for choosing AssembleAtEase — it means the world to a small local business.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    Ref: ${esc(b.ref)} &bull; AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;

  const result = await sendEmail({
    to: b.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `How was your ${esc(b.service)} service? Leave a quick review`,
    html,
    replyTo: ownerEmail(),
  });

  if (!result.ok) {
    console.error('Review request send error:', result.error);
    return res.status(500).json({ error: 'Failed to send review email' });
  }

  // Mark as sent so the cron doesn't double-send
  await sb.from('bookings').update({ review_requested_at: new Date().toISOString() }).eq('id', b.id);

  return res.status(200).json({ success: true });
}
