import { createHmac, timingSafeEqual } from 'crypto';

const REVIEW_TOKEN_PURPOSE = 'customer-review';
export const REVIEW_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function reviewTokenSecret() {
  if (process.env.VERCEL_ENV === 'production' && !process.env.GUEST_ACCESS_TOKEN_SECRET) {
    throw new Error('GUEST_ACCESS_TOKEN_SECRET is required for review links in production');
  }
  const secret = process.env.GUEST_ACCESS_TOKEN_SECRET
    || process.env.CRON_SECRET
    || process.env.STRIPE_WEBHOOK_SECRET
    || process.env.STRIPE_SECRET_KEY;
  if (!secret || String(secret).length < 32) {
    throw new Error('A review-link signing secret of at least 32 characters is required');
  }
  return String(secret);
}

function normalizeReviewIdentity({ ref, email } = {}) {
  return {
    ref: String(ref || '').trim().toUpperCase(),
    email: String(email || '').trim().toLowerCase(),
  };
}

function signatureInput(encodedPayload, identity) {
  return `${encodedPayload}.${identity.ref}.${identity.email}`;
}

function sign(encodedPayload, identity) {
  return createHmac('sha256', reviewTokenSecret())
    .update(signatureInput(encodedPayload, identity))
    .digest('base64url');
}

export function issueReviewToken({
  bookingId,
  ref,
  email,
  nowMs = Date.now(),
  ttlMs = REVIEW_TOKEN_TTL_MS,
} = {}) {
  const identity = normalizeReviewIdentity({ ref, email });
  const normalizedBookingId = String(bookingId || '').trim();
  if (!normalizedBookingId || !identity.ref || !identity.email) {
    throw new Error('Review token identity is incomplete');
  }
  const issuedAtMs = Math.floor(Number(nowMs));
  const lifetimeMs = Math.floor(Number(ttlMs));
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > REVIEW_TOKEN_TTL_MS) {
    throw new Error('Review token lifetime is invalid');
  }
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    p: REVIEW_TOKEN_PURPOSE,
    bid: normalizedBookingId,
    iat: issuedAtMs,
    exp: issuedAtMs + lifetimeMs,
  })).toString('base64url');
  return `${payload}.${sign(payload, identity)}`;
}

export function verifyReviewToken(token, {
  bookingId,
  ref,
  email,
  nowMs = Date.now(),
} = {}) {
  try {
    const identity = normalizeReviewIdentity({ ref, email });
    const normalizedBookingId = String(bookingId || '').trim();
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !normalizedBookingId || !identity.ref || !identity.email) return false;

    const [encodedPayload, suppliedSignature] = parts;
    const expectedSignature = sign(encodedPayload, identity);
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const checkedAtMs = Math.floor(Number(nowMs));
    if (!Number.isFinite(checkedAtMs)) return false;
    return payload?.v === 1
      && payload?.p === REVIEW_TOKEN_PURPOSE
      && payload?.bid === normalizedBookingId
      && Number.isInteger(payload?.iat)
      && Number.isInteger(payload?.exp)
      && payload.iat <= checkedAtMs + MAX_CLOCK_SKEW_MS
      && payload.exp > checkedAtMs
      && payload.exp - payload.iat > 0
      && payload.exp - payload.iat <= REVIEW_TOKEN_TTL_MS;
  } catch (_) {
    return false;
  }
}
