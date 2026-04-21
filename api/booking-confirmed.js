import { getSupabase } from './_supabase.js';
import { sendEmail, ownerEmail, esc } from './_email.js';
import { rateLimit } from './_ratelimit.js';

/**
 * POST /api/booking-confirmed
 * Called by the frontend after Stripe card authorization succeeds.
 * Sends the customer confirmation email now that payment is on file.
 * Body: { bookingId: string }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });

  const { bookingId } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

  const sb = getSupabase();
  const { data: booking, error } = await sb
    .from('bookings')
    .select('ref, service, customer_name, customer_phone, customer_email, address, date, time, details, total_price, is_deposit, deposit_amount')
    .eq('id', bookingId)
    .single();

  if (error || !booking) {
    console.error('booking-confirmed fetch error:', error);
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Mark card as authorized in Supabase so booking/complete.js can capture the charge.
  // This is critical — without this update, payment_status stays 'pending' and the
  // Stripe capture block in complete.js is skipped, meaning revenue is never collected.
  const { error: updateErr } = await sb
    .from('bookings')
    .update({ payment_status: 'authorized' })
    .eq('id', bookingId);

  if (updateErr) {
    console.error('booking-confirmed status update error:', updateErr);
    // Non-fatal: still send email, but log for manual resolution
  }

  const { ref, service, customer_name: name, customer_email: email, address, date, time, details,
          total_price: amount, is_deposit: isDeposit, deposit_amount: depositAmountCents } = booking;

  const sName    = esc(name);
  const sService = esc(service);
  const sAddress = esc(address);
  const sDate    = esc(date);
  const sTime    = esc(time);
  const sDetails = esc(details);

  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const SITE = 'https://www.assembleatease.com';
  const TO   = ownerEmail();

  const paymentLine = amount > 0
    ? isDeposit && depositAmountCents
      ? `Your card is securely held. A 25% deposit ($${(depositAmountCents / 100).toFixed(2)}) confirms your appointment. The remaining balance ($${((amount - depositAmountCents) / 100).toFixed(2)}) is charged only after the job is complete.`
      : `Your card has been authorized for $${(amount / 100).toFixed(2)} and will only be charged once the job is complete and you confirm you're satisfied.`
    : `No upfront payment. You pay only when you're 100% satisfied with the work.`;

  const customerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">You're booked, ${sName}!</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Your payment is on file and your appointment is confirmed. A member of our team will reach out within <strong>1 hour</strong> with any final details.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Booking Reference</td><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px;text-align:right">Status</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#1a1a1a">${ref}</td><td style="text-align:right"><span style="display:inline-block;background:#d1fae5;color:#065f46;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">CONFIRMED</span></td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Appointment Details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Services</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sService}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sDate}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sTime}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${sAddress}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:10px 0;line-height:1.6">${sDetails || 'None'}</td></tr>
    </table>
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We confirm your appointment</strong> — We'll reach out within 1 hour to confirm date, time, and scope.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Your technician arrives</strong> — On the scheduled date, a licensed, insured professional arrives with all their tools.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Pay after completion</strong> — ${paymentLine}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#92400e;line-height:1.6">
      <strong>Cancellation policy:</strong> Cancel at least 24 hours before your appointment at no charge. Cancellations within 24 hours may incur a 50% fee. No-shows will be charged the full amount.
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="mailto:service@assembleatease.com" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Questions? Contact Us</a>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Austin, TX &bull; Licensed &bull; Insured &bull; Background Checked</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">You received this email because a booking was submitted at assembleatease.com. To cancel or reschedule, reply to this email.</p>
  </td></tr></table>
</div></body></html>`;

  const result = await sendEmail({
    from: 'AssembleAtEase <booking@assembleatease.com>',
    to: email,
    subject: `Booking Confirmed — ${ref}`,
    html: customerHtml,
    replyTo: TO,
  });

  if (!result.ok) {
    console.error('booking-confirmed send error:', result.error);
    return res.status(500).json({ error: 'Failed to send confirmation email' });
  }

  return res.status(200).json({ success: true });
}
