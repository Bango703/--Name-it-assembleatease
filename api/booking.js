export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { service, name, phone, email, address, date, time, details } = req.body;
  const KEY = process.env.RESEND_API_KEY;
  const TO  = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';

  const ownerHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:2rem 1rem">
  <div style="background:#00bcd4;border-radius:16px 16px 0 0;padding:2rem;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:1.5rem">&#128722; New Booking Request</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.4rem 0 0;font-size:0.9rem">AssembleAtEase &bull; Austin TX</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:0 0 16px 16px;padding:2rem">
    <div style="background:#e0f7fa;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.5rem;border-left:4px solid #00bcd4">
      <p style="margin:0;font-size:0.78rem;color:#00838f;font-weight:700;text-transform:uppercase">Services Requested</p>
      <p style="margin:0.4rem 0 0;font-size:1.05rem;font-weight:700;color:#0d1117">${service}</p>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;width:120px;font-weight:600">Customer</td><td style="padding:0.65rem 0;font-weight:700;color:#0d1117">${name}</td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600">Phone</td><td style="padding:0.65rem 0"><a href="tel:${phone}" style="color:#00bcd4;font-weight:700;text-decoration:none">${phone}</a></td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600">Email</td><td style="padding:0.65rem 0"><a href="mailto:${email}" style="color:#00bcd4;font-weight:600;text-decoration:none">${email}</a></td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600">Address</td><td style="padding:0.65rem 0;font-weight:600;color:#0d1117">${address}</td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600">Date</td><td style="padding:0.65rem 0;font-weight:700;color:#00838f;font-size:1.05rem">${date}</td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600">Time</td><td style="padding:0.65rem 0;font-weight:700;color:#00838f;font-size:1.05rem">${time}</td></tr>
      <tr><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600;vertical-align:top">Details</td><td style="padding:0.65rem 0;color:#374151;line-height:1.7">${details}</td></tr>
    </table>
    <div style="margin-top:1.5rem;padding:1rem;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0">
      <p style="margin:0;font-size:0.875rem;color:#166534;font-weight:700">&#128205; Action required</p>
      <p style="margin:0.3rem 0 0;font-size:0.85rem;color:#166534">Contact ${name} at <a href="tel:${phone}" style="color:#166534">${phone}</a> or <a href="mailto:${email}" style="color:#166534">${email}</a> to confirm this appointment.</p>
    </div>
  </div>
  <p style="text-align:center;font-size:0.72rem;color:#9ca3af;margin-top:1rem">AssembleAtEase &bull; Austin, TX &bull; service@assembleatease.com</p>
</div></body></html>`;

  const customerHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:2rem 1rem">
  <div style="background:linear-gradient(135deg,#00bcd4,#00838f);border-radius:16px 16px 0 0;padding:2.5rem;text-align:center">
    <div style="width:64px;height:64px;background:rgba(255,255,255,0.2);border-radius:50%;margin:0 auto 1rem;display:flex;align-items:center;justify-content:center;font-size:2rem;line-height:64px">&#10003;</div>
    <h1 style="color:#fff;margin:0;font-size:1.7rem">Booking Confirmed!</h1>
    <p style="color:rgba(255,255,255,0.88);margin:0.5rem 0 0;font-size:1rem">Thank you for choosing AssembleAtEase, ${name}!</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;padding:2rem">
    <p style="color:#374151;line-height:1.8;margin-bottom:1.5rem;font-size:0.95rem">We have received your booking request and will contact you within <strong style="color:#00838f">1 hour</strong> to confirm your appointment. Here is a full summary of your booking:</p>
    <div style="background:#e0f7fa;border-radius:12px;padding:1.25rem;margin-bottom:1.5rem;border:1px solid #b2ebf2">
      <p style="margin:0 0 0.5rem;font-size:0.75rem;font-weight:700;color:#00838f;text-transform:uppercase;letter-spacing:0.06em">Services Requested</p>
      <p style="margin:0;font-size:1rem;font-weight:700;color:#0d1117">${service}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:1.5rem">
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.7rem 0;color:#6b7280;font-size:0.85rem;width:150px">Appointment Date</td><td style="padding:0.7rem 0;font-weight:700;color:#00838f;font-size:1.05rem">${date}</td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.7rem 0;color:#6b7280;font-size:0.85rem">Appointment Time</td><td style="padding:0.7rem 0;font-weight:700;color:#00838f;font-size:1.05rem">${time}</td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.7rem 0;color:#6b7280;font-size:0.85rem">Service Address</td><td style="padding:0.7rem 0;font-weight:600;color:#0d1117">${address}</td></tr>
      <tr><td style="padding:0.7rem 0;color:#6b7280;font-size:0.85rem;vertical-align:top">Your Details</td><td style="padding:0.7rem 0;color:#374151;line-height:1.7;font-size:0.875rem">${details}</td></tr>
    </table>
    <div style="background:#f0fdf4;border-radius:10px;padding:1.25rem;border:1px solid #bbf7d0;margin-bottom:1rem">
      <p style="margin:0 0 0.4rem;font-size:0.9rem;font-weight:700;color:#166534">&#128204; What happens next?</p>
      <p style="margin:0;font-size:0.875rem;color:#166534;line-height:1.75">We will reach out to you within <strong>1 hour</strong> to confirm your appointment details, answer any questions, and make sure everything is ready for your visit.</p>
    </div>
    <div style="background:#fff8e1;border-radius:10px;padding:1.25rem;border:1px solid #ffe082">
      <p style="margin:0;font-size:0.9rem;font-weight:700;color:#92400e">&#128176; No upfront payment required</p>
      <p style="margin:0.3rem 0 0;font-size:0.85rem;color:#92400e;line-height:1.7">You only pay after the work is fully completed to your satisfaction. We stand behind every job we do.</p>
    </div>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:0 0 16px 16px;padding:1.5rem;text-align:center;border-top:none">
    <p style="margin:0 0 0.75rem;font-size:0.875rem;color:#6b7280">Have a question? Reach out anytime.</p>
    <a href="mailto:service@assembleatease.com" style="display:inline-block;background:#00bcd4;color:#fff;padding:0.65rem 1.75rem;border-radius:999px;text-decoration:none;font-weight:700;font-size:0.875rem">service@assembleatease.com</a>
  </div>
  <p style="text-align:center;font-size:0.72rem;color:#9ca3af;margin-top:1rem">AssembleAtEase &bull; Austin, TX &bull; Professional Assembly &amp; Handyman Services</p>
</div></body></html>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
        to: [TO],
        subject: 'New Booking � ' + service + ' from ' + name,
        html: ownerHtml,
        reply_to: email,
      }),
    });
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase <booking@assembleatease.com>',
        to: [email],
        subject: 'Booking Confirmed � We received your request!',
        html: customerHtml,
      }),
    });
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}
