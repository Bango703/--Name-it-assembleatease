import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

// POST /api/owner/rebook-invite
// Owner-triggered, branded "ready to book again?" outreach to a past customer.
// Sends through the platform (logged, on-brand) with a /book link prefilled with the
// customer's contact details + rebook attribution. This is the in-app alternative to
// a plain mailto: the customer completes a real, card-authorized booking themselves.
// Body: { email (required), name?, phone? }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = String(body.email || '').trim();
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const preview = body.preview === true;   // return the exact email without sending

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'A valid customer email is required.' });
  }

  const firstName = name ? name.split(/\s+/)[0] : 'there';
  const bookUrl = `${SITE}/book?`
    + `name=${encodeURIComponent(name)}`
    + `&email=${encodeURIComponent(email)}`
    + `&phone=${encodeURIComponent(phone)}`
    + `&utm_source=owner&utm_medium=email&utm_campaign=rebook`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a1a">Need us again, ${esc(firstName)}?</p>
    <p style="margin:0 0 18px;font-size:14px;color:#52525b;line-height:1.7">Thanks for booking with AssembleAtEase before. Whenever you have furniture to assemble, a TV to mount, smart-home setup, fitness or outdoor gear, or an office to put together, we're ready to help — booking takes about two minutes and your details are already filled in.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 18px;width:100%"><tr><td style="background:#00BFFF;border-radius:8px;padding:0;text-align:center"><a href="${bookUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px">Book Your Next Job</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Just reply to this email — we're glad to help.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Serving customers across Texas
  </td></tr></table>
</div></body></html>`;

  const subject = 'Ready to book AssembleAtEase again?';

  // Preview mode: hand back the exact subject + HTML the customer would receive, so the
  // owner can review it in the dashboard before anything is sent. Nothing leaves here.
  if (preview) {
    return res.status(200).json({ ok: true, preview: true, to: email, subject, html });
  }

  const result = await sendEmail({
    to: email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject,
    html,
    replyTo: ownerEmail(),
    meta: { notificationType: 'customer_rebook_invite', recipientType: 'customer', disableDedupe: true },
  });

  if (!result?.ok || result.suppressed === true) {
    console.error('Rebook invite send error:', result?.error);
    return res.status(502).json({ error: 'The email was not accepted. Nothing was sent.' });
  }
  return res.status(200).json({ ok: true });
}
