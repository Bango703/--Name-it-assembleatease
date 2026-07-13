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

export function safeTokenHashMatch(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
