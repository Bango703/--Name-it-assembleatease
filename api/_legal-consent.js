import crypto from 'crypto';

export const CUSTOMER_TERMS_VERSION = '2026-08-27-sms-v1';
export const PRIVACY_NOTICE_VERSION = '2026-08-27-sms-v1';

function normalizedHeader(value, maxLength = 500) {
  return String(Array.isArray(value) ? value[0] : (value || ''))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength) || null;
}

function consentHashSecret() {
  return process.env.LEGAL_CONSENT_HASH_SECRET
    || process.env.GUEST_ACCESS_TOKEN_SECRET
    || process.env.OWNER_SESSION_SECRET
    || process.env.STRIPE_WEBHOOK_SECRET
    || process.env.STRIPE_SECRET_KEY
    || null;
}

export function validateCustomerLegalConsent(input = {}) {
  if (input.termsAccepted !== true) {
    return { ok: false, status: 400, code: 'TERMS_ACCEPTANCE_REQUIRED', error: 'Review and accept the current Terms before continuing.' };
  }
  if (String(input.termsVersion || '') !== CUSTOMER_TERMS_VERSION
      || String(input.privacyNoticeVersion || '') !== PRIVACY_NOTICE_VERSION) {
    return {
      ok: false,
      status: 409,
      code: 'LEGAL_VERSION_CHANGED',
      error: 'Our Terms or Privacy Notice changed. Refresh the page, review the current versions, and try again.',
    };
  }
  return { ok: true };
}

export function buildCustomerConsentRecord(req, method = 'online_checkout_checkbox') {
  const forwardedFor = normalizedHeader(req?.headers?.['x-forwarded-for'], 300);
  const rawIp = (forwardedFor || normalizedHeader(req?.socket?.remoteAddress, 100) || 'unknown')
    .split(',')[0]
    .trim();
  const secret = consentHashSecret();
  const ipHash = secret
    ? crypto.createHmac('sha256', String(secret)).update(rawIp).digest('hex')
    : crypto.createHash('sha256').update(rawIp).digest('hex');

  return {
    customer_terms_version: CUSTOMER_TERMS_VERSION,
    customer_terms_accepted_at: new Date().toISOString(),
    customer_terms_acceptance_method: String(method || 'online_checkout_checkbox').slice(0, 80),
    customer_privacy_notice_version: PRIVACY_NOTICE_VERSION,
    customer_terms_acceptance_ip_hash: ipHash,
    customer_terms_acceptance_user_agent: normalizedHeader(req?.headers?.['user-agent'], 500),
  };
}
