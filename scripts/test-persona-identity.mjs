#!/usr/bin/env node
// Persona identity verification (owner, 2026-11-21). Persona is a second
// provider behind the same seam as Stripe Identity; it is OFF unless chosen and
// configured, any Persona failure falls back to Stripe, and only a signed
// webhook can mark an Easer verified. No network: fetch and the database are fakes.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PERSONA_API, PERSONA_API_VERSION, createPersonaInquiry, generatePersonaLink, identityProvider,
  personaFollowupStage, personaInquiryResumable, personaOutcome, verifyPersonaSignature,
} from '../api/_persona.js';
import { identityFollowupStage } from '../api/_identity-followup.js';
import personaWebhook from '../api/webhook/persona.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ok  ${name}`); }
const SECRET = 'wbhsec_test';
const sign = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const full = { IDENTITY_PROVIDER: 'persona', PERSONA_API_KEY: 'persona_sandbox_x', PERSONA_INQUIRY_TEMPLATE_ID: 'itmpl_x' };

// ── 1. Off unless chosen and configured ─────────────────────────────────────
await check('Stripe stays the provider unless Persona is chosen AND configured', () => {
  assert.equal(identityProvider({}), 'stripe');
  assert.equal(identityProvider({ IDENTITY_PROVIDER: 'persona' }), 'stripe', 'chosen but no keys');
  assert.equal(identityProvider({ ...full, PERSONA_INQUIRY_TEMPLATE_ID: '' }), 'stripe', 'no template');
  assert.equal(identityProvider({ ...full, IDENTITY_PROVIDER: 'stripe' }), 'stripe');
  assert.equal(identityProvider(full), 'persona');
  assert.equal(identityProvider({ ...full, IDENTITY_PROVIDER: ' Persona ' }), 'persona');
});

// ── 2. Signatures ───────────────────────────────────────────────────────────
await check('the webhook signature is checked: right secret, untouched body, recent, rotation-safe', () => {
  const body = '{"data":{}}';
  assert.equal(verifyPersonaSignature(body, sign(body), SECRET), true);
  assert.equal(verifyPersonaSignature(Buffer.from(body), sign(body), SECRET), true);
  assert.equal(verifyPersonaSignature(body, sign(body, undefined, 'other'), SECRET), false, 'wrong secret');
  assert.equal(verifyPersonaSignature('{"data":{"x":1}}', sign(body), SECRET), false, 'tampered body');
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(verifyPersonaSignature(body, sign(body, old), SECRET), false, 'replayed an hour later');
  const t = Math.floor(Date.now() / 1000);
  const good = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  assert.equal(verifyPersonaSignature(body, `t=${t},v1=deadbeef ${good}`, SECRET), true, 'secret rotation sends two');
  for (const header of [undefined, '', 'v1=abc', `t=${t}`, `t=${t},v1=zz`]) assert.equal(verifyPersonaSignature(body, header, SECRET), false, String(header));
  assert.equal(verifyPersonaSignature(body, sign(body), ''), false, 'no secret configured');
});

// ── 3. What Persona's answers mean ──────────────────────────────────────────
await check('events and statuses map to verified, retry, review or nothing', () => {
  assert.equal(personaOutcome('inquiry.completed'), 'verified');
  assert.equal(personaOutcome('inquiry.approved'), 'verified');
  assert.equal(personaOutcome('inquiry.failed'), 'retry');
  assert.equal(personaOutcome('inquiry.declined'), 'retry');
  assert.equal(personaOutcome('inquiry.marked-for-review'), 'review');
  for (const e of ['inquiry.created', 'inquiry.started', 'inquiry.expired', 'account.created', '', null]) assert.equal(personaOutcome(e), 'ignore', String(e));
  assert.equal(personaInquiryResumable('created'), true);
  assert.equal(personaInquiryResumable('pending'), true);
  for (const s of ['completed', 'approved', 'failed', 'declined', 'expired', 'needs_review']) assert.equal(personaInquiryResumable(s), false, s);
  assert.equal(personaFollowupStage('created'), 'not_started');
  assert.equal(personaFollowupStage('pending'), 'started_not_finished');
  assert.equal(personaFollowupStage('expired'), 'started_not_finished');
  assert.equal(personaFollowupStage('needs_review'), 'in_review');
  assert.equal(personaFollowupStage('completed'), 'verified_unrecorded');
  assert.equal(personaFollowupStage('weird'), 'unknown');
});
await check('the follow-up reminders read Persona when Persona holds the check', () => {
  const p = { identity_provider: 'persona', persona_inquiry_id: 'inq_1', stripe_identity_session_id: 'vs_old' };
  assert.equal(identityFollowupStage(p, null, { inquiry: { status: 'pending' } }), 'started_not_finished');
  assert.equal(identityFollowupStage(p, null, { inquiry: { status: 'completed' } }), 'verified_unrecorded');
  assert.equal(identityFollowupStage(p, null, { sessionLookupFailed: true }), 'unknown');
  assert.equal(identityFollowupStage({ stripe_identity_session_id: 'vs_1' }, { status: 'processing' }), 'in_review', 'Stripe unchanged');
  const cron = read('api/cron/identity-followup.js');
  assert.match(cron, /async function loadPersonaRefs\(sb, ids\)/, 'Persona columns read with their own query');
  assert.doesNotMatch(cron.match(/const PROFILE_SELECT = '[^']*'/)[0], /persona/, 'the main select works before migration 133');
});

// ── 4. The API calls ────────────────────────────────────────────────────────
await check('an inquiry is created on the template with the Easer as reference, and a one-time link is returned', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/inquiries')) return new Response(JSON.stringify({ data: { id: 'inq_123', attributes: { status: 'created', 'reference-id': 'p1' } } }), { status: 201 });
    return new Response(JSON.stringify({ meta: { 'one-time-link': 'https://withpersona.com/verify?code=abc' } }), { status: 200 });
  };
  const inquiry = await createPersonaInquiry({ profileId: 'p1', redirectUri: 'https://www.assembleatease.com/assembler/verify-identity?verification=complete', nameFirst: 'Pat', email: 'pat@example.com' }, { env: full, fetchImpl });
  assert.deepEqual([inquiry.id, inquiry.status, inquiry.referenceId], ['inq_123', 'created', 'p1']);
  assert.equal(calls[0].url, `${PERSONA_API}/inquiries`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer persona_sandbox_x');
  assert.equal(calls[0].init.headers['Persona-Version'], PERSONA_API_VERSION);
  assert.equal(calls[0].body.data.attributes['inquiry-template-id'], 'itmpl_x');
  assert.equal(calls[0].body.data.attributes['reference-id'], 'p1');
  assert.equal(calls[0].body.data.attributes.fields['name-first'], 'Pat');
  const link = await generatePersonaLink('inq_123', { env: full, fetchImpl });
  assert.equal(link, 'https://withpersona.com/verify?code=abc');
  assert.equal(calls[1].url, `${PERSONA_API}/inquiries/inq_123/generate-one-time-link`);
  const failing = async () => new Response(JSON.stringify({ errors: [{ title: 'Unauthorized' }] }), { status: 401 });
  await assert.rejects(createPersonaInquiry({ profileId: 'p1' }, { env: full, fetchImpl: failing }), /failed \(401\): Unauthorized/);
});

await check('a Persona failure gives the applicant a Stripe check, never an error from Persona', async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  try {
    Object.assign(process.env, full);
    delete process.env.STRIPE_SECRET_KEY;
    globalThis.fetch = async () => { throw new Error('persona down'); };
    const { createIdentityVerificationSession } = await import('../api/_assembler-onboarding.js');
    const sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: 'Pat Doe', email: 'p@example.com' }, error: null }) }) }) }) };
    // Persona throws -> the Stripe branch runs (which here stops at "Stripe is not configured").
    await assert.rejects(createIdentityVerificationSession(sb, { profileId: 'p1' }), /Stripe is not configured/);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const src = read('api/_assembler-onboarding.js');
  assert.match(src, /if \(identityProvider\(\) === 'persona'\) \{\n    try \{\n      return await createPersonaVerification/);
  assert.match(src, /console\.error\('\[identity\] Persona unavailable, using Stripe Identity:'/);
});

await check('a working Persona call reuses nothing stale and saves the inquiry on the profile', async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  const writes = [];
  try {
    Object.assign(process.env, full);
    globalThis.fetch = async (url) => (String(url).endsWith('/inquiries')
      ? new Response(JSON.stringify({ data: { id: 'inq_new', attributes: { status: 'created' } } }), { status: 201 })
      : new Response(JSON.stringify({ meta: { 'one-time-link': 'https://withpersona.com/verify?code=new' } }), { status: 200 }));
    const { createIdentityVerificationSession } = await import('../api/_assembler-onboarding.js');
    const sb = { from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { persona_inquiry_id: null, full_name: 'Pat Doe', email: 'p@example.com' }, error: null }) }) }),
      update: (values) => { writes.push(values); return { eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'p1' }, error: null }) }) }) }; },
    }) };
    const result = await createIdentityVerificationSession(sb, { profileId: 'p1', resumeToken: 'tok' });
    assert.deepEqual(result, { sessionId: 'inq_new', verificationUrl: 'https://withpersona.com/verify?code=new', provider: 'persona' });
    assert.deepEqual(writes[0], { persona_inquiry_id: 'inq_new', identity_provider: 'persona', id_verification_status: 'pending', identity_verified: false });
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// ── 5. The webhook ──────────────────────────────────────────────────────────
function fakeRes() {
  return { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function fakeSb(profile, { lookupError = null } = {}) {
  const events = [];
  return {
    events,
    from(table) {
      if (table === 'operational_events') return { insert: async (row) => { events.push(row); return { error: null }; } };
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: lookupError }) }) }) };
    },
  };
}
// What Persona read off the ID: by default the applicant's own name, an adult.
const govId = (first = 'Pat', last = 'Doe', birthdate = '1990-04-02') => ({ type: 'verification/government-id', id: 'ver_1', attributes: { status: 'passed', 'name-first': first, 'name-last': last, birthdate, 'completed-at': '2026-11-22T10:00:00Z' } });
function eventBody(name, { inquiryId = 'inq_1', ref = 'p1', included = [govId()] } = {}) {
  return JSON.stringify({ data: { type: 'event', id: `evt_${name}`, attributes: { name, payload: { data: { type: 'inquiry', id: inquiryId, attributes: { status: 'completed', 'reference-id': ref } }, included } } } });
}
async function deliver(body, profile, opts = {}) {
  const calls = { verified: [], retry: [], email: [], held: [] };
  const sb = fakeSb(profile, opts);
  const res = fakeRes();
  await personaWebhook({ method: 'POST', headers: { 'persona-signature': opts.signature ?? sign(body) } }, res, {
    secret: SECRET, rawBody: Buffer.from(body), sb,
    recordVerified: async (_sb, args) => { calls.verified.push(args); if (opts.writeFails) throw new Error('db down'); },
    recordRetry: async (_sb, args) => { calls.retry.push(args); },
    recordHeld: async (_sb, args) => { calls.held.push(args); },
    sendEmail: async (args) => { calls.email.push(args); return { ok: true }; },
  });
  return { res, calls, sb };
}
const applicant = { id: 'p1', role: 'assembler', full_name: 'Pat Doe', email: 'p@example.com', persona_inquiry_id: 'inq_1', identity_verified: false };

await check('a signed completed inquiry marks the Easer verified through the shared outcome, keyed once', async () => {
  const { res, calls } = await deliver(eventBody('inquiry.completed'), applicant);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.verified.length, 1);
  assert.equal(calls.verified[0].userId, 'p1');
  assert.deepEqual(calls.verified[0].referenceUpdates, { persona_inquiry_id: 'inq_1', identity_provider: 'persona' });
  assert.equal(calls.verified[0].notificationKey, 'persona:evt_inquiry.completed');
});
await check('a bad signature changes nothing', async () => {
  const body = eventBody('inquiry.completed');
  const { res, calls } = await deliver(body, applicant, { signature: sign(body, undefined, 'attacker') });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.verified.length, 0);
});
await check('an old inquiry, a non-Easer, a verified Easer or an unrelated event changes nothing', async () => {
  let r = await deliver(eventBody('inquiry.completed', { inquiryId: 'inq_old' }), applicant);
  assert.equal(r.res.body.reason, 'stale inquiry'); assert.equal(r.calls.verified.length, 0);
  r = await deliver(eventBody('inquiry.completed'), { ...applicant, role: 'customer' });
  assert.equal(r.res.body.ignored, true); assert.equal(r.calls.verified.length, 0);
  r = await deliver(eventBody('inquiry.completed'), { ...applicant, identity_verified: true });
  assert.equal(r.res.body.alreadyVerified, true); assert.equal(r.calls.verified.length, 0);
  r = await deliver(eventBody('inquiry.failed'), { ...applicant, identity_verified: true });
  assert.equal(r.calls.retry.length, 0, 'a late failure never un-verifies');
  r = await deliver(eventBody('inquiry.expired'), applicant);
  assert.equal(r.res.body.ignored, true);
});
await check('a failed check asks for a retry; a review case emails the owner', async () => {
  let r = await deliver(eventBody('inquiry.declined'), applicant);
  assert.equal(r.calls.retry.length, 1);
  assert.equal(r.calls.retry[0].reason, 'the ID check did not pass');
  r = await deliver(eventBody('inquiry.marked-for-review'), applicant);
  assert.equal(r.calls.email.length, 1);
  assert.match(r.calls.email[0].subject, /needs your review in Persona/);
  assert.equal(r.calls.email[0].meta.notificationKey, 'persona:evt_inquiry.marked-for-review:owner');
});
await check('a passed ID with a different name, no readable name, or under 18 is held, never verified (owner, 2026-11-22)', async () => {
  let r = await deliver(eventBody('inquiry.approved', { included: [govId('Travis', 'Gibson')] }), applicant);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.calls.verified.length, 0);
  assert.equal(r.calls.held.length, 1);
  assert.equal(r.calls.held[0].reason, 'name_mismatch');
  assert.equal(r.calls.held[0].documentName, 'Travis Gibson');
  r = await deliver(eventBody('inquiry.approved', { included: [] }), applicant);
  assert.equal(r.calls.verified.length, 0);
  assert.equal(r.calls.held[0].reason, 'name_unreadable');
  r = await deliver(eventBody('inquiry.approved', { included: [govId('Pat', 'Doe', '2012-01-01')] }), applicant);
  assert.equal(r.calls.verified.length, 0);
  assert.equal(r.calls.held[0].reason, 'under_minimum_age');
  r = await deliver(eventBody('inquiry.approved', { included: [govId('PATRICIA', 'DOE-SMITH')] }), { ...applicant, full_name: 'Patricia Ann Smith' });
  assert.equal(r.calls.verified.length, 1, 'middle names and a compound surname are the same person');
});
await check('our own write failure answers 503 so Persona retries', async () => {
  const { res } = await deliver(eventBody('inquiry.completed'), applicant, { writeFails: true });
  assert.equal(res.statusCode, 503);
});

// ── 6. One truth, honest copy ───────────────────────────────────────────────
await check('Stripe and Persona share one outcome module; nothing else marks an Easer verified', () => {
  const stripeHook = read('api/assembler/stripe-webhook.js');
  assert.match(stripeHook, /import \{ identityDocumentCheck, recordIdentityHeldForReview, recordIdentityRetry, recordIdentityVerified \} from '\.\.\/_identity-outcome\.js';/);
  // Both providers run the same name and age rule before marking anyone verified.
  assert.match(stripeHook, /expand: \['verified_outputs'\][\s\S]{0,400}identityDocumentCheck\(profile\.full_name[\s\S]{0,900}recordIdentityVerified\(/, 'Stripe checks the ID name before verifying');
  assert.match(read('api/webhook/persona.js'), /identityDocumentCheck\(profile\.full_name, personaDocumentOutputs\([\s\S]{0,500}await record\(/, 'Persona checks the ID name before verifying');
  assert.doesNotMatch(stripeHook, /function buildApplicantVerifiedEmail/, 'the email builders live in one place');
  const outcome = read('api/_identity-outcome.js');
  assert.match(outcome, /identity_verified: true,/);
  assert.doesNotMatch(read('api/webhook/persona.js'), /identity_verified: true/);
  assert.doesNotMatch(read('api/_persona.js'), /identity_verified: true/);
});
await check('the ID page copy is true for either provider', () => {
  const page = read('assembler/verify-identity.html');
  assert.doesNotMatch(page, /stripe/i);
  assert.match(page, /Our identity verification partner controls the raw verification data/);
});
await check('migration 133 adds the two columns, the webhook is routed and the decision names the legal gate', () => {
  const sql = read('api/migrations/133_persona_identity.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS persona_inquiry_id TEXT,/);
  assert.match(sql, /CHECK \(identity_provider IS NULL OR identity_provider IN \('stripe', 'persona'\)\)/);
  assert.match(read('api/webhook/persona.js'), /export const config = \{ api: \{ bodyParser: false \} \};/);
  const decision = read('docs/decisions/2026-11-21-persona-identity.md');
  assert.match(decision, /Legal wording to approve before go-live/);
  assert.match(decision, /api\/webhook\/persona/);
});

console.log(`persona identity: ${passed} checks passed`);
