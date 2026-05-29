import { createHmac, randomUUID } from 'crypto';

const OPERATIONAL_EVENTS_TABLE = 'operational_events';

const ALLOWED_REASON_CODES = new Set([
  'unauthorized_missing_bearer',
  'unauthorized_invalid_token',
  'invalid_input',
  'offer_not_found',
  'offer_expired',
  'booking_not_found',
  'booking_not_confirmed',
  'booking_already_assigned',
  'profile_not_found',
  'ineligible_status',
  'ineligible_identity',
  'ineligible_tier',
  'legacy_token_invalid',
  'race_lost',
  'db_write_failed',
  'notification_failure_nonfatal',
  'runtime_exception',
]);

const SENSITIVE_KEYS = new Set([
  'token',
  'dispatch_token',
  'assignment_token',
  'authorization',
  'email',
  'customer_email',
  'phone',
  'customer_phone',
  'full_name',
  'customer_name',
  'actor_name',
]);

function normalizeIncomingRequestId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 128) return '';
  if (!/^[a-zA-Z0-9._:-]+$/.test(raw)) return '';
  return raw;
}

export function buildRequestId(headers = {}) {
  const incoming =
    normalizeIncomingRequestId(headers['x-request-id']) ||
    normalizeIncomingRequestId(headers['x-correlation-id']) ||
    normalizeIncomingRequestId(headers['x-vercel-id']);

  if (incoming) return incoming;

  const now = Date.now().toString(36);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  return `obs_${now}_${suffix}`;
}

export function hashIdentifier(value, {
  secret = process.env.OBS_HASH_SECRET,
  prefix = 'id',
  length = 12,
} = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!secret) return null;

  const digest = createHmac('sha256', String(secret))
    .update(raw)
    .digest('hex')
    .slice(0, Math.max(8, length));

  return `${prefix}_${digest}`;
}

export function redactString(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b\d{3}[-.\s]?\d{2,4}[-.\s]?\d{4}\b/g, '[redacted-phone]')
    .replace(/\b[0-9a-f]{20,}\b/gi, '[redacted-token]')
    .slice(0, 240);
}

function sanitizeValue(key, value) {
  if (value == null) return null;

  if (SENSITIVE_KEYS.has(String(key || '').toLowerCase())) {
    return '[redacted]';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue('', entry));
  }

  if (typeof value === 'object') {
    return sanitizePayload(value);
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  return value;
}

export function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    result[key] = sanitizeValue(key, value);
  }
  return result;
}

export function getDeploymentMetadata() {
  return {
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null,
    commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
    app_version: process.env.VERCEL_GIT_COMMIT_REF || null,
  };
}

export function normalizeReasonCode({ reasonCode, statusCode, error } = {}) {
  const explicit = String(reasonCode || '').trim();
  if (ALLOWED_REASON_CODES.has(explicit)) {
    return explicit;
  }

  if (statusCode === 401) {
    return explicit === 'unauthorized_missing_bearer'
      ? 'unauthorized_missing_bearer'
      : 'unauthorized_invalid_token';
  }
  if (statusCode === 400) return 'invalid_input';
  if (statusCode === 404) return 'booking_not_found';
  if (statusCode === 409) return 'race_lost';
  if (statusCode === 410) return 'offer_expired';

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('profile')) return 'profile_not_found';
  if (message.includes('identity')) return 'ineligible_identity';
  if (message.includes('tier')) return 'ineligible_tier';
  if (message.includes('booking')) return 'booking_not_found';

  return 'runtime_exception';
}

export function normalizeActorRole(role) {
  const normalized = String(role || '').toLowerCase();
  if (['easer', 'owner', 'customer', 'system', 'cron', 'anonymous'].includes(normalized)) {
    return normalized;
  }
  return 'unknown';
}

export async function insertOperationalEventFailOpen(sb, event, {
  table = OPERATIONAL_EVENTS_TABLE,
  logger = console,
} = {}) {
  if (!sb || !event || typeof event !== 'object') return false;

  const row = {
    ...event,
    reason_code: normalizeReasonCode({
      reasonCode: event.reason_code,
      statusCode: event.status_code,
      error: event.error,
    }),
    reason_detail: redactString(event.reason_detail),
    actor_role: normalizeActorRole(event.actor_role),
    payload: sanitizePayload(event.payload),
  };

  try {
    await sb.from(table).insert(row);
    return true;
  } catch (e) {
    logger.warn('Operational event insert skipped:', e?.message || e);
    return false;
  }
}

export { OPERATIONAL_EVENTS_TABLE, ALLOWED_REASON_CODES };
