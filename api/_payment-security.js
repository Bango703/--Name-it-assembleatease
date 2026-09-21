import crypto from 'crypto';

function tokenSecret() {
  if (process.env.VERCEL_ENV === 'production' && !process.env.GUEST_ACCESS_TOKEN_SECRET) {
    throw new Error('GUEST_ACCESS_TOKEN_SECRET is required in production');
  }
  const secret = process.env.GUEST_ACCESS_TOKEN_SECRET
    || process.env.STRIPE_WEBHOOK_SECRET
    || process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('Guest access token secret is not configured');
  return String(secret);
}

export function assertGuestTokenConfiguration() {
  tokenSecret();
  return true;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function deriveGuestMutationToken({ bookingId, ref, email }) {
  const payload = `${bookingId}:${String(ref || '').toUpperCase()}:${String(email || '').trim().toLowerCase()}`;
  const signature = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  return `aae_guest_${signature}`;
}

export function guestMutationTokenHash(booking) {
  return sha256(deriveGuestMutationToken({
    bookingId: booking.id,
    ref: booking.ref,
    email: booking.customer_email,
  }));
}

// Build the customer's self-serve "manage booking" link for Track My Booking.
// When a live token is available, embed it so the customer can view, reschedule
// or cancel in ONE click — no email round-trip. Never embeds a stale token.
//
// Two ways a live token is available:
//   1. `plainToken` — a caller that JUST rotated the token passes the new one.
//      Without this, every email sent after a rotation was tokenless FOR THE
//      REST OF THE BOOKING'S LIFE, because the deterministic token can never
//      match a random hash again. The customer clicked link after link and got
//      a dead end each time.
//   2. The deterministic token still matches the stored hash, i.e. nothing has
//      rotated it yet.
//
// With neither, the link carries ref and email only. /api/booking/track refuses
// that — by design, it is not an authenticated view — so track.html treats a
// tokenless arrival as "send me a fresh link or let me use a code" rather than
// showing a dead form.
// Requires booking { id, ref, customer_email, guest_mutation_token_hash }.
export function guestManageUrl(booking, site = 'https://www.assembleatease.com', plainToken = null) {
  const ref = String(booking?.ref || '');
  const email = String(booking?.customer_email || '');
  const base = `${site}/track?ref=${encodeURIComponent(ref)}`;
  const withToken = token => `${base}&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
  try {
    // A token handed to us is only trusted if it really is the stored one.
    if (plainToken && email && booking?.guest_mutation_token_hash
        && safeTokenHashMatch(plainToken, booking.guest_mutation_token_hash)) {
      return withToken(plainToken);
    }
    const token = deriveGuestMutationToken({ bookingId: booking.id, ref, email });
    if (booking.guest_mutation_token_hash && sha256(token) === booking.guest_mutation_token_hash) {
      return withToken(token);
    }
  } catch (_) { /* fall through to tokenless link */ }
  return email ? `${base}&email=${encodeURIComponent(email)}` : base;
}

export function safeTokenHashMatch(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
