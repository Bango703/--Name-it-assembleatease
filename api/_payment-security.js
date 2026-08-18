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
// When the deterministic token still matches the stored hash (i.e. it has NOT
// been rotated by a reschedule/recovery), embed it so the customer can reschedule
// or cancel in ONE click — no email round-trip. If it was rotated, fall back to a
// tokenless track link (status view + "request a secure link"), never a stale one.
// Requires booking { id, ref, customer_email, guest_mutation_token_hash }.
export function guestManageUrl(booking, site = 'https://www.assembleatease.com') {
  const ref = String(booking?.ref || '');
  const email = String(booking?.customer_email || '');
  const base = `${site}/track?ref=${encodeURIComponent(ref)}`;
  try {
    const token = deriveGuestMutationToken({ bookingId: booking.id, ref, email });
    if (booking.guest_mutation_token_hash && sha256(token) === booking.guest_mutation_token_hash) {
      return `${base}&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
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
