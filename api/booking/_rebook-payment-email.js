import { esc, ownerEmail, sendEmail } from '../_email.js';

const SITE = String(process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com').replace(/\/$/, '');

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function formatRebookDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value || '');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(value || '');
  return new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(parsed);
}

export function rebookPaymentUrl({ bookingId, token }) {
  return `${SITE}/api/booking/rebook-payment?bookingId=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(token)}`;
}

export function buildRebookPaymentEmail({ booking, paymentUrl }) {
  const firstName = String(booking.customer_name || 'there').trim().split(/\s+/)[0] || 'there';
  const subtotalCents = Math.max(0, Number(booking.total_price || 0) - Number(booking.tax_amount || 0));
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b"><div style="max-width:600px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px"><p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#0369a1">AssembleAtEase</p><h1 style="margin:0 0 12px;font-size:24px">Complete your rebooking</h1><p style="margin:0 0 18px;line-height:1.7">Hi ${esc(firstName)}, please review the replacement appointment below and add a payment method to continue.</p><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:18px 0"><table width="100%" style="border-collapse:collapse;font-size:14px"><tr><td style="padding:6px 0;color:#64748b">Booking</td><td style="padding:6px 0;text-align:right;font-weight:700">${esc(booking.ref)}</td></tr><tr><td style="padding:6px 0;color:#64748b">Service</td><td style="padding:6px 0;text-align:right;font-weight:700">${esc(booking.service)}</td></tr><tr><td style="padding:6px 0;color:#64748b">Date</td><td style="padding:6px 0;text-align:right">${esc(formatRebookDate(booking.date))}${booking.time ? ` at ${esc(booking.time)}` : ''}</td></tr><tr><td style="padding:6px 0;color:#64748b">Address</td><td style="padding:6px 0;text-align:right">${esc(booking.address)}</td></tr>${booking.details ? `<tr><td style="padding:6px 0;color:#64748b;vertical-align:top">Job details</td><td style="padding:6px 0;text-align:right">${esc(booking.details)}</td></tr>` : ''}<tr><td style="padding:9px 0;border-top:1px solid #e2e8f0;color:#64748b">Service subtotal</td><td style="padding:9px 0;border-top:1px solid #e2e8f0;text-align:right">${money(subtotalCents)}</td></tr><tr><td style="padding:6px 0;color:#64748b">Texas sales tax</td><td style="padding:6px 0;text-align:right">${money(booking.tax_amount)}</td></tr><tr><td style="padding:9px 0;font-size:16px;font-weight:800">Total</td><td style="padding:9px 0;text-align:right;font-size:18px;font-weight:800">${money(booking.total_price)}</td></tr></table></div><p style="font-size:14px;line-height:1.65;color:#52525b">Nothing is charged when you add your card. For appointments within the authorization window, the total is authorized and held for capture after completed work. Later appointments are authorized closer to the service date.</p><p style="text-align:center;margin:24px 0"><a href="${esc(paymentUrl)}" style="display:inline-block;background:#00BFFF;color:#002b3a;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:800">Add payment method</a></p><p style="font-size:12px;line-height:1.6;color:#71717a">The replacement appointment is not ready for assignment until its payment requirement is completed. This secure link is only for booking ${esc(booking.ref)}. If any detail is incorrect, reply before adding your card.</p><p style="font-size:12px;line-height:1.6;color:#71717a">Questions? Reply to this email, call (979) 232-5139, or email service@assembleatease.com.</p></div></div></body></html>`;
}

export async function sendRebookPaymentEmail({ booking, token, disableDedupe = false }) {
  const paymentUrl = rebookPaymentUrl({ bookingId: booking.id, token });
  return sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Complete your rebooking - ${booking.ref}`,
    replyTo: ownerEmail(),
    html: buildRebookPaymentEmail({ booking, paymentUrl }),
    meta: {
      bookingId: booking.id,
      notificationType: 'rebook_payment_method_requested',
      recipientType: 'customer',
      ...(disableDedupe ? { disableDedupe: true } : { dedupeWindowMin: 2 }),
    },
  });
}
