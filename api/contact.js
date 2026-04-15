import { upsertContact, addNote } from './_hubspot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { name, email, subject, message } = req.body;
  const KEY = process.env.RESEND_API_KEY;
  const TO  = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

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
    <p style="margin:0 0 24px;font-size:22px;font-weight:700;color:#1a1a1a">${subject || 'New Message'}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:110px">From</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${name}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${email}" style="color:#0097a7;text-decoration:none;font-weight:600">${email}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Subject</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${subject || 'No subject'}</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Message</p>
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${message}</p>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af">Reply Required</p>
      <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">Reply directly to this email or contact <strong>${name}</strong> at <a href="mailto:${email}" style="color:#1e40af">${email}</a>.</p>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa;line-height:1.6">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a><br/>Licensed &bull; Insured &bull; Background Checked
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
    // HubSpot CRM — non-blocking
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        const contactId = await upsertContact({ email, name, lifecycleStage: 'lead' });
        if (contactId) {
          await addNote({ contactId, body: '<strong>Contact Form</strong><br>Subject: ' + (subject || 'N/A') + '<br>Message: ' + message });
        }
      } catch (err) { console.error('HubSpot contact error:', err); }
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}
