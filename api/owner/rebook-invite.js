import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

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

  // A FRAGMENT, not a document. A full <!DOCTYPE> passes straight through
  // ensureEmailShell untouched, which is how this email ended up with a footer
  // reading only "Serving customers across Texas" while every other email
  // carries the phone number, the contact address and the opt-out line. The
  // CAN-SPAM footer is added by sendEmail because this is marketing mail.
  const html = `
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#1a1a1a">${esc(firstName)}, your details are saved.</p>
    <p style="margin:0 0 22px;font-size:15px;color:#52525b;line-height:1.7">Your next job takes about two minutes to book.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 18px;width:100%"><tr><td style="background:#00BFFF;border-radius:8px;text-align:center">
      <a href="${bookUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">Book Your Next Job</a>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Reply to this email if you want a hand picking the right service.</p>`;

  const subject = `${firstName}, book your next job in two minutes`;

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
