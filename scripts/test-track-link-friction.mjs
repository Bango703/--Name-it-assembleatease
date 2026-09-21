import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.GUEST_ACCESS_TOKEN_SECRET = process.env.GUEST_ACCESS_TOKEN_SECRET
  || process.env.STRIPE_WEBHOOK_SECRET
  || 'test-secret-for-track-link-parity';

const { guestManageUrl, deriveGuestMutationToken, sha256, randomToken } =
  await import('../api/_payment-security.js');

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

// A customer clicked the link in their confirmation email and landed on a form
// asking for a 6-digit code. Three things caused it, and each is held here.

const booking = {
  id: '11111111-1111-1111-1111-111111111111',
  ref: 'AAE-TRACK1',
  customer_email: 'customer@example.com',
};
const deterministic = deriveGuestMutationToken({
  bookingId: booking.id, ref: booking.ref, email: booking.customer_email,
});

// ── 1. An untouched booking links straight in ──────────────────────────────
const live = { ...booking, guest_mutation_token_hash: sha256(deterministic) };
assert.match(guestManageUrl(live), /token=/, 'an unrotated booking must link straight into the booking');

// ── 2. After a rotation the link can still work, if the token is handed over
// Before this, the deterministic token could never match a random hash again,
// so EVERY later email for that booking was tokenless for the rest of its life.
const fresh = randomToken(32);
const rotated = { ...booking, guest_mutation_token_hash: sha256(fresh) };
assert.doesNotMatch(guestManageUrl(rotated), /token=/,
  'a rotated booking must never be sent a stale token');
assert.match(guestManageUrl(rotated, 'https://x', fresh), /token=/,
  'a caller that just rotated must be able to hand over the new token');

// A token that is not the stored one is refused, however it arrives.
assert.doesNotMatch(guestManageUrl(rotated, 'https://x', randomToken(32)), /token=/,
  'a token that does not match the stored hash must never be embedded');
assert.doesNotMatch(guestManageUrl(rotated, 'https://x', deterministic), /token=/,
  'the superseded deterministic token must not come back through the new argument');

// ── 3. Asking for a link must not kill the link already in the inbox ───────
// request-track-link rotated on every call, so a customer holding two of these
// emails could only open the newest — and opening the older one requested
// another, killing the newer one.
const requestLink = await read('api/booking/request-track-link.js');
assert.match(requestLink, /reuseExisting/,
  'requesting a link must reuse the live token instead of rotating every time');
assert.match(requestLink, /!emailResult\?\.ok && !reuseExisting/,
  'only a token this call actually replaced may be rolled back');

// ── 4. A link that cannot authenticate must not be a dead end ──────────────
const track = await read('track.html');
assert.match(track, /function offerCodeEntry/,
  'a failed lookup must hand the customer the code path, not leave them stranded');
assert.match(track, /offerCodeEntry\(email\)/,
  'the failed-lookup branch must call it, with the email it already has');
assert.match(track, /That link has expired, so we have emailed you a fresh one/,
  'the customer must be told the link expired — not shown a bare form');

console.log('track link friction: PASS — live links work, rotation is survivable, dead ends offer the code');
