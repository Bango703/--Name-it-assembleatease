export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { name, email, subject, message } = req.body;
  const KEY = process.env.RESEND_API_KEY;
  const TO  = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const ownerHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:2rem 1rem">
  <div style="background:#00bcd4;border-radius:16px 16px 0 0;padding:2rem;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:1.5rem">&#9993; New Contact Message</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.4rem 0 0;font-size:0.9rem">AssembleAtEase &bull; Austin TX</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:0 0 16px 16px;padding:2rem">
    <table style="width:100%;border-collapse:collapse">
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;width:120px;font-weight:600">From</td><td style="padding:0.65rem 0;font-weight:700;color:#0d1117">${name}</td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600">Email</td><td style="padding:0.65rem 0"><a href="mailto:${email}" style="color:#00bcd4;font-weight:600;text-decoration:none">${email}</a></td></tr>
      <tr style="border-bottom:1px solid #f3f4f6"><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600">Subject</td><td style="padding:0.65rem 0;font-weight:600;color:#0d1117">${subject || 'No subject'}</td></tr>
      <tr><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;font-weight:600;vertical-align:top">Message</td><td style="padding:0.65rem 0;color:#374151;line-height:1.7">${message}</td></tr>
    </table>
    <div style="margin-top:1.5rem;padding:1rem;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0">
      <p style="margin:0;font-size:0.875rem;color:#166534;font-weight:700">&#128205; Reply to this customer</p>
      <p style="margin:0.3rem 0 0;font-size:0.85rem;color:#166534">Reply directly to this email or contact ${name} at <a href="mailto:${email}" style="color:#166534">${email}</a>.</p>
    </div>
  </div>
  <p style="text-align:center;font-size:0.72rem;color:#9ca3af;margin-top:1rem">AssembleAtEase &bull; Austin, TX &bull; service@assembleatease.com</p>
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
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}
