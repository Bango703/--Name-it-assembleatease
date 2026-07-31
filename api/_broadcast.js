import crypto from 'crypto';

// Shared helpers for the customer broadcast tool: per-recipient unsubscribe
// tokens (so a one-click link opts out exactly one address and can't be forged),
// the CAN-SPAM footer, and email normalization. Kept separate from _email.js so
// transactional email behavior is untouched.

const SITE = 'https://www.assembleatease.com';

// CAN-SPAM requires a valid physical postal address in every marketing/
// announcement email. Set BUSINESS_POSTAL_ADDRESS to your real mailing address
// (street, PO box, or CMRA). The fallback is NOT a complete postal address —
// promos should not go out until this is set to something the USPS could deliver.
export function businessPostalAddress() {
  return (process.env.BUSINESS_POSTAL_ADDRESS || 'AssembleAtEase LLC, Austin, TX 78701').trim();
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function unsubSecret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.CRON_SECRET || '';
}

// A short HMAC over the address. Leaking a token only lets someone unsubscribe
// that one address (low harm), but it still must not be guessable.
export function makeUnsubToken(email) {
  const secret = unsubSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret)
    .update('unsub:' + normalizeEmail(email))
    .digest('hex')
    .slice(0, 32);
}

export function verifyUnsubToken(email, token) {
  const expected = makeUnsubToken(email);
  const provided = String(token || '');
  if (!expected || expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

export function unsubscribeUrl(email) {
  const e = normalizeEmail(email);
  return `${SITE}/api/unsubscribe?e=${encodeURIComponent(e)}&t=${makeUnsubToken(e)}`;
}

// Appended to every broadcast body. Contains the two CAN-SPAM must-haves: a
// clear unsubscribe mechanism and a physical postal address.
export function broadcastFooter(email) {
  const url = unsubscribeUrl(email);
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;border-top:1px solid #e4e4e7"><tr><td style="padding:16px 4px 0">
    <p style="margin:0 0 6px;font-size:12px;color:#a1a1aa;line-height:1.6">You're receiving this because you booked with or subscribed to AssembleAtEase.</p>
    <p style="margin:0 0 6px;font-size:12px;color:#a1a1aa;line-height:1.6">${businessPostalAddress()}</p>
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.6"><a href="${url}" style="color:#71717a;text-decoration:underline">Unsubscribe</a> from these emails at any time.</p>
  </td></tr></table>`;
}
