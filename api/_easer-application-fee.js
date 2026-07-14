import crypto from 'crypto';

export const EASER_APPLICATION_FEE_CENTS = 3000;
export const EASER_APPLICATION_FEE_CURRENCY = 'usd';
export const EASER_APPLICATION_FEE_DISPLAY = `$${(EASER_APPLICATION_FEE_CENTS / 100).toFixed(2)}`;
export const EASER_APPLICATION_FEE_CONTINUATION_TTL_MS = 30 * 60 * 1000;
export const EASER_APPLICATION_FEE_CONSENT_VERSION = `easer-application-fee-${EASER_APPLICATION_FEE_CENTS}-${EASER_APPLICATION_FEE_CURRENCY}-2026-07-13-v1`;

const APPLICATION_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isApplicationFeeSatisfied(profile = {}) {
  return profile.application_fee_refunded !== true
    && Number(profile.application_fee_refunded_cents || 0) === 0
    && Number(profile.application_fee_refund_pending_cents || 0) === 0
    && !profile.application_fee_refund_review_required_at
    && (
      profile.application_fee_paid === true
      || profile.application_fee_waived === true
      || profile.fee_waived_by_owner === true
    );
}

export function hasEaserApplicationFeeRefundHold(profile = {}) {
  return profile.application_fee_refunded === true
    || Number(profile.application_fee_refunded_cents || 0) > 0
    || Number(profile.application_fee_refund_pending_cents || 0) > 0
    || Boolean(profile.application_fee_refund_review_required_at);
}

export function validateEaserApplicationPaymentIntent(paymentIntent, {
  userId,
  paymentIntentId = null,
  customerId = null,
  requireSucceeded = false,
  requireConsent = false,
} = {}) {
  const paymentCustomerId = typeof paymentIntent?.customer === 'string'
    ? paymentIntent.customer
    : paymentIntent?.customer?.id || null;
  const valid = paymentIntent?.id
    && (!paymentIntentId || paymentIntent.id === paymentIntentId)
    && paymentIntent.metadata?.type === 'assembler_application_fee'
    && paymentIntent.metadata?.userId === userId
    && paymentIntent.currency === EASER_APPLICATION_FEE_CURRENCY
    && Number(paymentIntent.amount || 0) === EASER_APPLICATION_FEE_CENTS
    && (!customerId || paymentCustomerId === customerId)
    && (!requireConsent || hasEaserApplicationFeeConsent(paymentIntent))
    && (!requireSucceeded || (
      paymentIntent.status === 'succeeded'
      && Number(paymentIntent.amount_received || 0) === EASER_APPLICATION_FEE_CENTS
    ));
  if (!valid) throw new Error('Stripe application fee does not match this Easer or the canonical fee');
  return true;
}

export function easerApplicationFeeConsentMetadata(now = new Date()) {
  return {
    applicationFeeConsent: 'true',
    applicationFeeConsentVersion: EASER_APPLICATION_FEE_CONSENT_VERSION,
    applicationFeeConsentAt: now.toISOString(),
  };
}

export function hasEaserApplicationFeeConsent(paymentIntent) {
  const consentAt = Date.parse(String(paymentIntent?.metadata?.applicationFeeConsentAt || ''));
  return paymentIntent?.metadata?.applicationFeeConsent === 'true'
    && paymentIntent?.metadata?.applicationFeeConsentVersion === EASER_APPLICATION_FEE_CONSENT_VERSION
    && Number.isFinite(consentAt);
}

function continuationSecret(overrideSecret) {
  if (overrideSecret) return String(overrideSecret);
  if (process.env.VERCEL_ENV === 'production' && !process.env.GUEST_ACCESS_TOKEN_SECRET) {
    throw new Error('GUEST_ACCESS_TOKEN_SECRET is required for application-fee continuations in production');
  }
  const secret = process.env.GUEST_ACCESS_TOKEN_SECRET
    || process.env.STRIPE_WEBHOOK_SECRET
    || process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('Application-fee continuation signing secret is not configured');
  return String(secret);
}

export function isValidApplicationAttemptId(value) {
  return APPLICATION_ATTEMPT_PATTERN.test(String(value || ''));
}

export function hashApplicationAttemptId(value) {
  if (!isValidApplicationAttemptId(value)) throw new Error('Invalid application attempt identifier');
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function applicationAttemptMatches(value, expectedHash) {
  if (!isValidApplicationAttemptId(value) || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) return false;
  const actual = Buffer.from(hashApplicationAttemptId(value), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createApplicationFeeContinuationToken({
  profileId,
  paymentIntentId,
  now = Date.now(),
  secret,
} = {}) {
  if (!profileId || !/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntentId || ''))) {
    throw new Error('Application-fee continuation is missing required identifiers');
  }
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    pid: String(profileId),
    pi: String(paymentIntentId),
    exp: Number(now) + EASER_APPLICATION_FEE_CONTINUATION_TTL_MS,
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', continuationSecret(secret))
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyApplicationFeeContinuationToken(token, {
  now = Date.now(),
  secret,
} = {}) {
  const raw = String(token || '');
  if (!raw || raw.length > 2048) throw new Error('Application-fee continuation is invalid or expired');
  const [payload, suppliedSignature, extra] = raw.split('.');
  if (!payload || !suppliedSignature || extra) throw new Error('Application-fee continuation is invalid or expired');

  const expectedSignature = crypto
    .createHmac('sha256', continuationSecret(secret))
    .update(payload)
    .digest();
  let actualSignature;
  try {
    actualSignature = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    throw new Error('Application-fee continuation is invalid or expired');
  }
  if (actualSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    throw new Error('Application-fee continuation is invalid or expired');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Application-fee continuation is invalid or expired');
  }
  const expiresAt = Number(parsed?.exp);
  if (parsed?.v !== 1
      || !parsed?.pid
      || !/^pi_[A-Za-z0-9_]+$/.test(String(parsed?.pi || ''))
      || !Number.isFinite(expiresAt)
      || expiresAt <= Number(now)
      || expiresAt > Number(now) + EASER_APPLICATION_FEE_CONTINUATION_TTL_MS + 60_000) {
    throw new Error('Application-fee continuation is invalid or expired');
  }
  return {
    profileId: String(parsed.pid),
    paymentIntentId: String(parsed.pi),
    expiresAt,
  };
}

export function getFoundingEaserFreeApplicationLimit() {
  const configured = Number.parseInt(process.env.FOUNDING_EASER_FREE_APPLICATION_LIMIT || '20', 10);
  return Number.isFinite(configured) ? Math.min(10000, Math.max(0, configured)) : 20;
}

export async function getEaserApplicationFeeStatus(sb) {
  const foundingLimit = getFoundingEaserFreeApplicationLimit();
  const { count, error } = await sb
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'assembler')
    .eq('application_fee_waived', true);
  if (error) throw new Error(`Application fee status lookup failed: ${error.message || error}`);

  const foundingWaiversClaimed = Math.max(0, Number(count || 0));
  const waiverAvailable = foundingWaiversClaimed < foundingLimit;
  return {
    amountCents: waiverAvailable ? 0 : EASER_APPLICATION_FEE_CENTS,
    standardAmountCents: EASER_APPLICATION_FEE_CENTS,
    currency: EASER_APPLICATION_FEE_CURRENCY,
    waiverAvailable,
    foundingLimit,
    foundingWaiversClaimed,
    foundingWaiversRemaining: Math.max(0, foundingLimit - foundingWaiversClaimed),
    finalDecisionAtSubmission: true,
  };
}

export async function claimFoundingEaserApplicationStatus(sb, profileId) {
  const { data, error } = await sb.rpc('claim_founding_easer_waiver', {
    p_profile_id: profileId,
    p_limit: getFoundingEaserFreeApplicationLimit(),
  });
  if (error) throw error;

  const result = Array.isArray(data) ? data[0] : data;
  if (!result || typeof result.fee_waived !== 'boolean') {
    throw new Error('Founding waiver claim returned no authoritative result');
  }
  return {
    feeWaived: result.fee_waived,
    foundingNumber: result.founding_number || null,
  };
}
