/**
 * Persona identity verification (owner, 2026-11-21: "persona is open ... i need
 * that setup"). A second provider behind the same seam as Stripe Identity:
 * createIdentityVerificationSession() in _assembler-onboarding.js returns a
 * hosted link either way, and only a provider's signed webhook ever marks an
 * Easer verified (api/_identity-outcome.js).
 *
 * OFF until all of these are set in the environment:
 *   IDENTITY_PROVIDER=persona
 *   PERSONA_API_KEY               (Persona dashboard > API, sandbox or production key)
 *   PERSONA_INQUIRY_TEMPLATE_ID   (itmpl_..., the "Government ID and Selfie" template)
 *   PERSONA_WEBHOOK_SECRET        (Persona dashboard > Webhooks, for /api/webhook/persona)
 * Migration 133 adds the columns this writes. Anything missing keeps Stripe.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PERSONA_API = 'https://api.withpersona.com/api/v1';
export const PERSONA_API_VERSION = '2023-01-05';
const TIMEOUT_MS = 8000;

export function personaConfigured(env = process.env) {
  return Boolean(env.PERSONA_API_KEY && env.PERSONA_INQUIRY_TEMPLATE_ID);
}

/** 'persona' only when it is chosen AND fully configured; otherwise 'stripe'. */
export function identityProvider(env = process.env) {
  return String(env.IDENTITY_PROVIDER || '').trim().toLowerCase() === 'persona' && personaConfigured(env)
    ? 'persona'
    : 'stripe';
}

async function personaFetch(path, { method = 'GET', body, env = process.env, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${PERSONA_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.PERSONA_API_KEY}`,
        'Persona-Version': PERSONA_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!resp.ok) {
      const detail = json?.errors?.[0]?.title || json?.errors?.[0]?.detail || text.slice(0, 160);
      const error = new Error(`Persona ${method} ${path.split('?')[0]} failed (${resp.status}): ${detail}`);
      error.status = resp.status;
      throw error;
    }
    return json;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error(`Persona ${method} ${path.split('?')[0]} timed out`);
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function inquiryView(data) {
  const attributes = data?.attributes || {};
  return {
    id: data?.id || null,
    status: String(attributes.status || '').toLowerCase() || null,
    referenceId: attributes['reference-id'] || attributes.referenceId || null,
    createdAt: attributes['created-at'] || attributes.createdAt || null,
  };
}

/** Create an inquiry for this Easer on the configured template. */
export async function createPersonaInquiry({ profileId, redirectUri, nameFirst, nameLast, email, phone } = {}, opts = {}) {
  const env = opts.env || process.env;
  const fields = {};
  if (nameFirst) fields['name-first'] = nameFirst;
  if (nameLast) fields['name-last'] = nameLast;
  if (email) fields['email-address'] = email;
  if (phone) fields['phone-number'] = phone;
  const json = await personaFetch('/inquiries', {
    method: 'POST',
    env,
    fetchImpl: opts.fetchImpl,
    body: {
      data: {
        attributes: {
          'inquiry-template-id': env.PERSONA_INQUIRY_TEMPLATE_ID,
          'reference-id': profileId,
          'redirect-uri': redirectUri,
          ...(Object.keys(fields).length ? { fields } : {}),
        },
      },
    },
  });
  return inquiryView(json?.data);
}

/** A one-time hosted link that opens (or resumes) the inquiry. */
export async function generatePersonaLink(inquiryId, opts = {}) {
  const json = await personaFetch(`/inquiries/${encodeURIComponent(inquiryId)}/generate-one-time-link`, {
    method: 'POST',
    env: opts.env,
    fetchImpl: opts.fetchImpl,
  });
  const link = json?.meta?.['one-time-link'] || json?.meta?.oneTimeLink || null;
  if (!link) throw new Error('Persona returned no one-time link');
  return link;
}

export async function retrievePersonaInquiry(inquiryId, opts = {}) {
  const json = await personaFetch(`/inquiries/${encodeURIComponent(inquiryId)}`, { env: opts.env, fetchImpl: opts.fetchImpl });
  return inquiryView(json?.data);
}

/** An inquiry the applicant can still finish with a fresh link. */
export function personaInquiryResumable(status) {
  return ['created', 'pending'].includes(String(status || '').toLowerCase());
}

/**
 * Verify the Persona-Signature header: "t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * `${t}.${rawBody}`>". During a secret rotation Persona sends several v1 values
 * separated by spaces; any match is valid. Rejects anything older than the
 * tolerance so a captured request cannot be replayed later.
 */
export function verifyPersonaSignature(rawBody, header, secret, { nowMs = Date.now(), toleranceSec = 300 } = {}) {
  if (!secret || !header || rawBody === undefined || rawBody === null) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => {
    const i = p.indexOf('=');
    return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : [p.trim(), ''];
  }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return parts.v1.split(/\s+/).filter(Boolean).some(sig => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const given = Buffer.from(sig, 'hex');
    return given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf);
  });
}

/**
 * What a Persona event means for the Easer (Persona is the truth for the
 * inquiry, as Stripe is for its session):
 *   verified  inquiry.completed / inquiry.approved: every required check passed
 *   retry     inquiry.failed / inquiry.declined: a new attempt is needed
 *   review    inquiry.marked-for-review: a person must look in Persona
 *   ignore    anything else (created, started, expired: the follow-up cron reminds)
 */
export function personaOutcome(eventName) {
  switch (String(eventName || '').toLowerCase()) {
    case 'inquiry.completed':
    case 'inquiry.approved':
      return 'verified';
    case 'inquiry.failed':
    case 'inquiry.declined':
      return 'retry';
    case 'inquiry.marked-for-review':
      return 'review';
    default:
      return 'ignore';
  }
}

/** Follow-up stage from a retrieved inquiry (same stages as identityFollowupStage). */
export function personaFollowupStage(status) {
  switch (String(status || '').toLowerCase()) {
    case 'completed':
    case 'approved':
      return 'verified_unrecorded';
    case 'needs_review':
      return 'in_review';
    case 'created':
      return 'not_started';
    case 'pending':
    case 'expired':
    case 'failed':
    case 'declined':
      return 'started_not_finished';
    default:
      return 'unknown';
  }
}
