// Server failures, reported to the same Sentry project as the browser
// (owner, 2026-11-10). Failures were already written to operational_events
// and cron_log, but nothing told anyone: a refused insert or a failing cron
// was found days later, by hand. Sentry emails when a new kind of failure
// starts, and groups repeats.
//
// No SDK: a serverless function is frozen as soon as it responds, so a
// background queue would lose the event. reportServerError() sends one request
// and waits for it, at most TIMEOUT_MS, and never throws.
//
// Privacy: send only what the caller gives, and callers give already-redacted
// text (redactString in api/_observability.js) and short identifiers. No
// payloads, no customer or Easer details, no request bodies.
//
// Imports nothing from this repo, so _observability.js can import it.

const TIMEOUT_MS = 1500;
const REPEAT_WINDOW_MS = 60_000;
// The public project DSN, as in assets/js/sentry-init.js. SENTRY_DSN overrides
// it; outside production nothing is sent unless SENTRY_DSN is set.
const PRODUCTION_DSN = 'https://d5e773248c17d9f13dcf8b0a5f5dd73f@o4511934287249408.ingest.us.sentry.io/4511934297473024';

const recent = new Map();

export function sentryDsn(env = process.env) {
  if (env.SENTRY_DSN === 'off') return '';
  if (env.SENTRY_DSN) return env.SENTRY_DSN;
  return env.VERCEL_ENV === 'production' ? PRODUCTION_DSN : '';
}

export function parseDsn(dsn) {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!url.username || !/^\d+$/.test(projectId)) return null;
    return { key: url.username, envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/` };
  } catch {
    return null;
  }
}

const clip = (value, max) => (value == null ? undefined : String(value).slice(0, max));

function cleanTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags || {})) {
    if (v == null || v === '') continue;
    out[clip(k, 32)] = clip(v, 200);
  }
  return out;
}

export function buildEnvelope({ message, detail, level = 'error', tags, fingerprint, dsn, env = process.env, now = new Date() }) {
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: 'node',
    level,
    logger: 'aae-server',
    environment: env.VERCEL_ENV || env.NODE_ENV || 'development',
    release: clip(env.VERCEL_GIT_COMMIT_SHA, 64),
    message: { formatted: clip(message, 300) },
    tags: { runtime: 'server', ...cleanTags(tags) },
    extra: detail ? { detail: clip(detail, 1000) } : undefined,
    fingerprint: Array.isArray(fingerprint) && fingerprint.length ? fingerprint.map((f) => clip(f, 120)) : undefined,
  };
  const body = JSON.stringify(event);
  return [
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString(), dsn }),
    JSON.stringify({ type: 'event', content_type: 'application/json', length: Buffer.byteLength(body) }),
    body,
  ].join('\n');
}

/**
 * Report one server failure. Returns true when Sentry accepted it, false when
 * reporting is off, the same failure was sent in the last minute from this
 * instance, or Sentry could not be reached. Never throws.
 *
 * message:     fixed text naming what failed ("Cron reminders failed").
 * detail:      redacted error text.
 * tags:        short identifiers (route, event_type, reason_code, cron).
 * fingerprint: what makes two reports the same failure.
 */
export async function reportServerError({ message, detail, level = 'error', tags = {}, fingerprint } = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  try {
    const dsn = sentryDsn(env);
    const parsed = dsn && parseDsn(dsn);
    if (!parsed || typeof fetchImpl !== 'function' || !message) return false;

    const repeatKey = JSON.stringify(fingerprint || [message, tags.route || '', tags.event_type || '']);
    const last = recent.get(repeatKey);
    if (last && now() - last < REPEAT_WINDOW_MS) return false;
    recent.set(repeatKey, now());
    if (recent.size > 200) recent.delete(recent.keys().next().value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(parsed.envelopeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=aae-server/1.0`,
        },
        body: buildEnvelope({ message, detail, level, tags, fingerprint, dsn, env, now: new Date(now()) }),
        signal: controller.signal,
      });
      return Boolean(response && response.ok);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// operational_events rows that are a failure worth telling someone about.
// runtime_error rows are browser errors, which the browser already sends to
// Sentry itself.
export function isReportableOperationalEvent(row) {
  if (!row || typeof row !== 'object') return false;
  const type = String(row.event_type || '');
  if (type === 'runtime_error') return false;
  if (Number(row.status_code) >= 500) return true;
  return /(_failed|_failure|_error)$/.test(type);
}

export function _resetSentryForTests() {
  recent.clear();
}
