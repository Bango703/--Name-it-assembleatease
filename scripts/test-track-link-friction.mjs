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

// ── The owner can put the link in the customer's hands ─────────────────────
// A customer who cannot find their confirmation had no remedy on the board:
// resend existed for quotes, reviews, payment links and payout reminders, but
// not for the booking itself, and no tracking link was visible anywhere.
{
  const endpoint = await read('api/owner/resend-booking-details.js');
  assert.match(endpoint, /verifyOwner\(req\)/, 'owner only');
  assert.match(endpoint, /safeTokenHashMatch\(plainToken, tokenHash\)/,
    'reuse the live token when there is one');
  assert.match(endpoint, /randomToken\(32\)/,
    'mint a working one when the stored token was rotated, so the link is never dead');
  assert.match(endpoint, /\.eq\('guest_mutation_token_hash', booking\.guest_mutation_token_hash\)/,
    'rotation must be compare-and-set');
  assert.match(endpoint, /guestManageUrl\(\s*\{ \.\.\.booking, guest_mutation_token_hash: tokenHash \}, SITE, plainToken/,
    'the fresh token must reach the link builder');
  assert.match(endpoint, /trackUrl,\n\s+\}\);/,
    'a failed send must still return the link — the owner is on the phone');
  assert.match(endpoint, /booking_details_resent/, 'the resend belongs on the timeline');
  // The original confirmation describes the booking as it was that day. Sending
  // it again can state things that are no longer true.
  assert.doesNotMatch(endpoint, /Nothing is charged today/,
    'this sends current state, not a replay of the original confirmation');

  const owner = await read('owner/index.html');
  assert.match(owner, /data-action="resend-booking-details"/, 'the board must offer it');
  assert.match(owner, /function showTrackLink/, 'and show the link for reading out or copying');
  assert.match(owner, /\['cancelled', 'declined'\]\.includes\(b\.status\)/,
    'not offered on a booking with nothing left to track');
}

console.log('owner resend: PASS — details and a working link, from the booking');
