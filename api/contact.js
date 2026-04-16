import { upsertContact, addNote } from './_hubspot.js';
import { rateLimit } from './_ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(ip, 5, 60000)) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  const { name, email, subject, message } = req.body;
  const KEY = process.env.RESEND_API_KEY;
  const TO  = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const esc = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const sName = esc(name);
  const sEmail = esc(email);
  const sSubject = esc(subject);
  const sMessage = esc(message);

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
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Contact Form Submission</p>
    <p style="margin:0 0 24px;font-size:22px;font-weight:700;color:#1a1a1a">${sSubject || 'New Message'}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:110px">From</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sName}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${sEmail}" style="color:#0097a7;text-decoration:none;font-weight:600">${sEmail}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Subject</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sSubject || 'No subject'}</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Message</p>
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sMessage}</p>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af">Reply Required</p>
      <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">Reply directly to this email or contact <strong>${sName}</strong> at <a href="mailto:${sEmail}" style="color:#1e40af">${sEmail}</a>.</p>
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
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">We received your message,&nbsp;${sName}.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Thank you for reaching out. Our team will review your message and respond within <strong>24 hours</strong>.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Your Message</p>
      <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#1a1a1a">${sSubject || 'General Inquiry'}</p>
      <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">${sMessage}</p>
    </td></tr></table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We review your message</strong> &mdash; Our team reads every inquiry personally.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We respond within 24 hours</strong> &mdash; You'll hear back from us via email or phone.</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">
      <strong style="color:#1a1a1a">Need immediate help?</strong> Call or text us directly and we'll get back to you right away.
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="tel:+15127018878" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Call Us</a>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Austin, TX &bull; Licensed &bull; Insured &bull; Background Checked</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">You received this email because a message was submitted at assembleatease.com. If you did not make this request, please disregard this email.</p>
  </td></tr></table>
</div></body></html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase Contact <contact@assembleatease.com>',
        to: [TO],
        subject: 'Contact Form — ' + (subject || 'New message') + ' from ' + name,
        html: ownerHtml,
        reply_to: email,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send email' });
    }
    // Send confirmation to customer
    const customerResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase <contact@assembleatease.com>',
        to: [email],
        subject: 'We received your message - AssembleAtEase',
        html: customerHtml,
      }),
    });
    if (!customerResp.ok) {
      console.error('Resend customer error:', await customerResp.text());
    }
    // HubSpot CRM — non-blocking
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        const contactId = await upsertContact({ email, name, lifecycleStage: 'lead' });
        if (contactId) {
          const escHtml = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        await addNote({ contactId, body: '<strong>Contact Form</strong><br>Subject: ' + escHtml(subject || 'N/A') + '<br>Message: ' + escHtml(message) });
        }
      } catch (err) { console.error('HubSpot contact error:', err); }
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}



