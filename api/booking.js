import { upsertContact, createDeal } from './_hubspot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { service, name, phone, email, address, date, time, details } = req.body;
  const KEY = process.env.RESEND_API_KEY;
  const TO  = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';
  const ref = 'AAE-' + Date.now().toString(36).toUpperCase();
  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const SITE = 'https://www.assembleatease.com';

  const ownerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Notification</td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">New Booking Request</p>
    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1a1a1a">Ref: ${ref}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Services</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;line-height:1.5">${service}</p>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:110px;vertical-align:top">Customer</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${name}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Phone</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="tel:${phone}" style="color:#0097a7;text-decoration:none;font-weight:600">${phone}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${email}" style="color:#0097a7;text-decoration:none">${email}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${address}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${date}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${time}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Details</td><td style="padding:10px 0;line-height:1.6">${details || 'None provided'}</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af">Action Required</p>
      <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">Contact <strong>${name}</strong> at <a href="tel:${phone}" style="color:#1e40af">${phone}</a> or <a href="mailto:${email}" style="color:#1e40af">${email}</a> to confirm this appointment.</p>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa;line-height:1.6">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a><br/>Licensed &bull; Insured &bull; Background Checked
  </td></tr></table>
</div></body></html>`;

  const customerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">We received your booking,&nbsp;${name}.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Thank you for choosing AssembleAtEase. A member of our team will contact you within <strong>1 hour</strong> to confirm your appointment.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Booking Reference</td><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px;text-align:right">Status</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#1a1a1a">${ref}</td><td style="text-align:right"><span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">PENDING CONFIRMATION</span></td></tr>
      </table>
    </td></tr></table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Appointment Details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Services</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${service}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${date}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${time}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${address}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:10px 0;line-height:1.6">${details || 'None'}</td></tr>
    </table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Confirmation call</strong> — We'll call or text within 1 hour to confirm date, time, and scope.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Your technician arrives</strong> — On the scheduled date, a licensed, insured professional will arrive with all tools needed.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Pay after completion</strong> — No upfront payment. You pay only when you're 100% satisfied with the work.</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">
      <strong style="color:#1a1a1a">Cancellation policy:</strong> We ask for at least 24 hours' notice to cancel or reschedule. Same-day cancellations affect our ability to serve other customers.
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="mailto:service@assembleatease.com" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Contact Us</a>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Austin, TX &bull; Licensed &bull; Insured &bull; Background Checked</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">You received this email because a booking was submitted at assembleatease.com. If you did not make this request, please disregard this email.</p>
  </td></tr></table>
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
    // HubSpot CRM — non-blocking
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        const contactId = await upsertContact({ email, name, phone, address, lifecycleStage: 'opportunity' });
        if (contactId) {
          await createDeal({ contactId, dealName: service + ' — ' + name, service, date, time, details });
        }
      } catch (err) { console.error('HubSpot booking error:', err); }
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}
