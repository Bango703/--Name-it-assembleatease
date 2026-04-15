import { upsertContact, addNote } from './_hubspot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email } = req.body;
  const KEY = process.env.RESEND_API_KEY;
  const TO  = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const ownerHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:2rem 1rem">
  <div style="background:linear-gradient(135deg,#0a1628,#132744);border-radius:16px 16px 0 0;padding:2rem;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:1.5rem">&#128221; New Assembler Waitlist Signup</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.4rem 0 0;font-size:0.9rem">AssembleAtEase &bull; Austin TX</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:0 0 16px 16px;padding:2rem">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:0.65rem 0;color:#6b7280;font-size:0.82rem;width:120px;font-weight:600">Email</td><td style="padding:0.65rem 0;font-weight:700;color:#0d1117"><a href="mailto:${email}" style="color:#00bcd4;text-decoration:none">${email}</a></td></tr>
    </table>
    <div style="margin-top:1.5rem;padding:1rem;background:#e0f7fa;border-radius:8px;border:1px solid #b2ebf2">
      <p style="margin:0;font-size:0.875rem;color:#00838f;font-weight:700">&#128205; Follow up</p>
      <p style="margin:0.3rem 0 0;font-size:0.85rem;color:#00838f">Reach out to this handyman at <a href="mailto:${email}" style="color:#00838f">${email}</a> to onboard them onto the platform.</p>
    </div>
  </div>
  <p style="text-align:center;font-size:0.72rem;color:#9ca3af;margin-top:1rem">AssembleAtEase &bull; Austin, TX &bull; service@assembleatease.com</p>
</div></body></html>`;

  const assemblerHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:2rem 1rem">
  <div style="background:linear-gradient(135deg,#00bcd4,#00838f);border-radius:16px 16px 0 0;padding:2.5rem;text-align:center">
    <div style="width:64px;height:64px;background:rgba(255,255,255,0.2);border-radius:50%;margin:0 auto 1rem;display:flex;align-items:center;justify-content:center;font-size:2rem;line-height:64px">&#10003;</div>
    <h1 style="color:#fff;margin:0;font-size:1.7rem">You're on the Waitlist!</h1>
    <p style="color:rgba(255,255,255,0.88);margin:0.5rem 0 0;font-size:1rem">Thank you for your interest in joining AssembleAtEase</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:0 0 16px 16px;padding:2rem">
    <p style="color:#374151;line-height:1.8;margin-bottom:1.5rem;font-size:0.95rem">We're excited that you want to join our growing network of skilled handymen and assemblers in <strong style="color:#00838f">Austin, TX</strong>.</p>
    <div style="background:#e0f7fa;border-radius:12px;padding:1.25rem;margin-bottom:1.5rem;border:1px solid #b2ebf2">
      <p style="margin:0 0 0.5rem;font-size:0.75rem;font-weight:700;color:#00838f;text-transform:uppercase;letter-spacing:0.06em">What happens next?</p>
      <p style="margin:0;font-size:0.9rem;color:#0d1117;line-height:1.7">We'll review your request and reach out when spots open up in your area. You'll be among the first to know!</p>
    </div>
    <div style="background:#f0fdf4;border-radius:10px;padding:1.25rem;border:1px solid #bbf7d0">
      <p style="margin:0 0 0.4rem;font-size:0.9rem;font-weight:700;color:#166534">&#127775; Why join AssembleAtEase?</p>
      <ul style="margin:0;padding-left:1.25rem;color:#166534;font-size:0.85rem;line-height:2">
        <li>Get matched with customers in your area</li>
        <li>Earn competitive pay on every job</li>
        <li>We handle the customer booking for you</li>
        <li>No upfront fees to join</li>
      </ul>
    </div>
  </div>
  <p style="text-align:center;font-size:0.72rem;color:#9ca3af;margin-top:1rem">AssembleAtEase &bull; Austin, TX &bull; service@assembleatease.com</p>
</div></body></html>`;

  try {
    // Send notification to owner
    const ownerResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase Waitlist <waitlist@assembleatease.com>',
        to: [TO],
        subject: 'New Assembler Waitlist Signup — ' + email,
        html: ownerHtml,
        reply_to: email,
      }),
    });
    if (!ownerResp.ok) {
      const err = await ownerResp.text();
      console.error('Resend owner error:', err);
      return res.status(500).json({ error: 'Failed to send notification' });
    }

    // Send confirmation to assembler
    const assemblerResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase <waitlist@assembleatease.com>',
        to: [email],
        subject: "You're on the AssembleAtEase Waitlist!",
        html: assemblerHtml,
      }),
    });
    if (!assemblerResp.ok) {
      const err = await assemblerResp.text();
      console.error('Resend assembler error:', err);
      // Still return success since owner was notified
    }

    // HubSpot CRM — non-blocking
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        const contactId = await upsertContact({ email, lifecycleStage: 'subscriber' });
        if (contactId) {
          await addNote({ contactId, body: '<strong>Assembler Waitlist Signup</strong><br>Interested in joining the AssembleAtEase handyman network.' });
        }
      } catch (err) { console.error('HubSpot waitlist error:', err); }
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}
