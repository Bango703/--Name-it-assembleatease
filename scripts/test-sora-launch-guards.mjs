import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getBookingCatalog, calculateBookingPricing } from '../api/_pricing.js';
import { getEaserReadiness } from '../api/_easer-readiness.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { toPublicEaserReadiness } from '../api/assembler/readiness.js';
import { prepareBookingContinuation } from '../api/ai/_booking-continuation.js';
import { createReceptionistHandler } from '../api/ai/receptionist.js';
import { readVoiceSelectionFragment, applyVoiceSelection } from '../assets/js/voice-booking-selection.js';
import { createVoiceWebhook, voiceEventProjection, verifyVoiceSignature } from '../api/webhooks/telnyx-voice.js';
import { soraCaseAttention, relatedSoraSourceRefs } from '../api/owner/cases.js';

globalThis.fetch = async () => { throw new Error('Network forbidden in Sora guard tests'); };
const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const catalog = getBookingCatalog();
const allItems = Object.entries(catalog.subcategories).flatMap(([service, groups]) =>
  groups.flatMap(group => group.items.map(item => ({ service, ...item }))));
const line = item => ({ service: item.service, name: item.name, qty: 2 });
const base = allItems.find(item => item.price > 0 && !item.addon && !item.customQuote);
const custom = allItems.find(item => item.customQuote);
const furniture = allItems.find(item => item.service === 'Furniture Assembly' && !item.addon && item.price > 0);
const fitness = allItems.find(item => item.service === 'Fitness Equipment' && !item.addon && item.price > 0);
function request(items = [line(furniture), line(fitness)]) {
  return { action: 'prepare_booking', items, selectionConfirmed: true, requestQuote: false };
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

// Every catalog item survives the handoff and gets prices/flags from the catalog.
for (const item of allItems) {
  const prepared = prepareBookingContinuation(request([line(item)]), catalog);
  assert.ok(prepared.value, item.name);
  const url = new URL(prepared.value.bookingUrl);
  assert.equal(url.origin, 'https://www.assembleatease.com');
  assert.equal(url.pathname, '/book');
  const parsed = readVoiceSelectionFragment(url.hash, catalog);
  const booking = { selectedServices: [], selectedItems: {}, wantsQuote: false };
  assert.equal(applyVoiceSelection(parsed.value, catalog, booking).ok, true);
  assert.equal(booking.selectedItems[item.service][0].price, item.price);
  assert.equal(booking.selectedItems[item.service][0].qty, 2);
  assert.equal(booking.wantsQuote, item.customQuote === true);
  assert.equal(prepared.value.bookingCreated, false);
  assert.equal(prepared.value.messageSent, false);
}
const multi = prepareBookingContinuation(request(), catalog).value;
assert.equal(multi.items.length, 2);
assert.deepEqual(multi.items.map(item => item.service), ['Furniture Assembly', 'Fitness Equipment']);
const mixed = prepareBookingContinuation(request([line(base), line(custom)]), catalog).value;
assert.equal(mixed.requiresQuote, true);
assert.equal(prepareBookingContinuation({ ...request(), requestQuote: true }, catalog).value.requiresQuote, true);
for (const bad of [
  { selectionConfirmed: false }, { selectionConfirmed: 'true' }, { items: [] },
  { items: [line(base), line(base)] }, { items: Array(26).fill(line(base)) },
  { items: [{ ...line(base), name: 'invented item' }] },
  { items: [{ ...line(base), service: '__proto__' }] },
  { items: [{ ...line(base), qty: 0 }] }, { items: [{ ...line(base), qty: 100 }] },
  { items: [{ ...line(base), qty: '2' }] }, { items: [{ ...line(base), qty: 1.1 }] },
  { items: [{ ...line(base), price: 1 }] }, { items: [{ ...line(base), customQuote: false }] },
  { phone: '5125550100' }, { email: 'private@example.com' }, { address: 'Private address' },
  { card: 'not-allowed' }, { bookingId: 'victim' }, { token: 'privileged-token' },
  { total: 1 }, { url: 'https://example.com' }, { termsAccepted: true }, { requestQuote: 'false' },
]) assert.ok(prepareBookingContinuation({ ...request(), ...bad }, catalog).error, JSON.stringify(bad));
for (const fragment of ['#sora=bad', '#sora=%', '#sora=' + 'a'.repeat(16001), '#other=value']) {
  assert.ok(readVoiceSelectionFragment(fragment, catalog).error);
}
const parsed = readVoiceSelectionFragment(new URL(multi.bookingUrl).hash, catalog).value;
for (const existing of [{ selectedServices: ['Other'] }, { selectedItems: { Other: [] } },
  { _guestMutationToken: 'keep' }, { _clientSecret: 'keep' }, { date: '2026-09-10' }, { email: 'keep@example.com' }]) {
  const before = structuredClone(existing);
  assert.ok(applyVoiceSelection(parsed, catalog, existing).error);
  assert.deepEqual(existing, before);
}
// Reopening after a catalog price change uses the new catalog, never stale money.
const revised = structuredClone(catalog);
const revisedItem = revised.subcategories[furniture.service].flatMap(group => group.items).find(item => item.name === furniture.name);
revisedItem.price = 888;
const updatedCart = {};
assert.equal(applyVoiceSelection(parsed, revised, updatedCart).ok, true);
assert.equal(updatedCart.selectedItems[furniture.service][0].price, 888);

const secret = 'fictional-sora-handoff-secret-for-tests-00000000';
for (const [enabled, authorized, expected] of [[false, true, 503], [true, false, 401], [true, true, 200]]) {
  const handler = createReceptionistHandler({ env: { TELNYX_AI_INTAKE_ENABLED: 'true',
    TELNYX_AI_TOOL_SECRET: secret, TELNYX_AI_BOOKING_HANDOFF_ENABLED: String(enabled) },
  supabase: () => { throw new Error('Read-only handoff must not reach database'); } });
  const res = response();
  await handler({ method: 'POST', body: request(), headers: { authorization: `Bearer ${authorized ? secret : 'wrong'}` } }, res);
  assert.equal(res.statusCode, expected);
}

// Execute the actual booking handler's validation prefix. No database or Stripe
// stubs are available before the quote guard: touching either fails the test.
const bookingSource = await read('api/booking.js');
const prefix = bookingSource.slice(bookingSource.indexOf('export default async function handler'), bookingSource.indexOf('  const sb = getSupabase();'));
assert.match(prefix, /pricing\.hasCustomQuote && !quoteRequested/);
const sandbox = {
  rateLimit: async () => true, guardCustomerFacing() {},
  validateCustomerLegalConsent: () => ({ ok: true }), normalizeUsPhone: () => '+15125550100',
  isActiveInstantBookingZip: () => true, parseServiceLocation: () => ({}),
  validateBookingWindowDate: () => ({ ok: true, requestedDate: new Date('2099-01-01') }),
  needsScheduledAuthorization: () => false, sameDayFeeForAppointment: () => 0,
  appointmentTimestampMs: () => Date.now() + 86400000,
  process: { env: {} }, ownerEmail: () => 'owner@example.com', randomToken: () => 'testonly',
  assertGuestTokenConfiguration() {}, calculateBookingPricing,
};
vm.createContext(sandbox);
vm.runInContext(prefix.replace('export default ', '') + '\nreturn res.status(299).json({ passedGuard: true });\n}', sandbox);
for (const items of [[base, custom], [custom]]) {
  for (const flag of [false, undefined, 'true', true]) {
    const body = { services: [...new Set(items.map(item => item.service))], items: {}, isQuoteRequest: flag,
      name: 'Fictional fixture', email: 'fixture@example.com', phone: '5125550100', address: 'Fictional', zip: '78701',
      date: '2099-01-01', time: '8:00 AM – 10:00 AM' };
    for (const item of items) (body.items[item.service] ||= []).push({ name: item.name, qty: 1, price: 1, customQuote: false });
    const res = response();
    await sandbox.handler({ method: 'POST', headers: {}, body }, res);
    assert.equal(res.statusCode, flag === true ? 299 : 409);
    if (flag !== true) assert.equal(res.body.code, 'CUSTOM_QUOTE_REQUIRED');
  }
}

const profile = { application_status: 'approved', status: 'active', tier: 'starter', phone: '5125550100',
  is_available: true, identity_verified: true, contractor_agreement_signed_at: '2026-09-01',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION, code_of_conduct_agreed_at: '2026-09-01' };
const readyAccount = { details_submitted: true, charges_enabled: true, payouts_enabled: true,
  requirements: { currently_due: [], past_due: [], disabled_reason: null } };
assert.equal((await getEaserReadiness(profile, { connectRequired: false })).isReady, true);
for (const account of [null, { ...readyAccount, details_submitted: false }, { ...readyAccount, payouts_enabled: false },
  { ...readyAccount, requirements: { currently_due: ['external_account'] } },
  { ...readyAccount, requirements: { past_due: ['document'] } },
  { ...readyAccount, requirements: { disabled_reason: 'rejected.other' } }]) {
  const readiness = await getEaserReadiness({ ...profile, stripe_connect_account_id: 'acct_fictional' },
    { connectRequired: true, stripeAccount: account });
  assert.equal(readiness.isReady, false);
  assert.ok(toPublicEaserReadiness(readiness).missingItems.includes('Payout setup complete'));
  assert.doesNotMatch(JSON.stringify(toPublicEaserReadiness(readiness)), /Stripe|external_account|document|rejected/);
}
assert.equal((await getEaserReadiness({ ...profile, stripe_connect_account_id: 'acct_fictional' },
  { connectRequired: true, stripeAccount: readyAccount })).isReady, true);
const unavailable = await getEaserReadiness({ ...profile, stripe_connect_account_id: 'acct_fictional' },
  { connectRequired: true, stripeClient: { accounts: { retrieve: async () => { throw new Error('Fixture outage'); } } } });
assert.equal(unavailable.isReady, false);

// Signed lifecycle fixtures, including hangup arriving before initiated.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const now = Date.parse('2026-09-06T22:00:00Z');
const timestamp = String(now / 1000);
const connection = '123456789';
const env = { TELNYX_AI_VOICE_EVENTS_ENABLED: 'true', VERCEL_ENV: 'production',
  TELNYX_AI_VOICE_CONNECTION_ID: connection, TELNYX_PUBLIC_KEY: publicRaw };
const fixture = { data: { id: '11111111-1111-4111-8111-111111111111', event_type: 'call.hangup',
  occurred_at: new Date(now).toISOString(), payload: { connection_id: connection,
    call_control_id: 'v3:fictional_call_for_local_test_12345', from: '+15125550100', to: '+15125550101',
    call_session_id: '22222222-2222-4222-8222-222222222222',
    transcript: 'MUST NOT STORE', recording_url: 'MUST NOT STORE', client_state: 'MUST NOT STORE',
    dtmf: 'MUST NOT STORE', hangup_cause: 'MUST NOT STORE' } } };
assert.doesNotMatch(JSON.stringify(voiceEventProjection(fixture, connection, now)), /MUST NOT STORE/);
function voiceHarness(overrides = {}) {
  const cases = new Map(); const events = new Map(); let serial = 0;
  const sb = { from(table) { assert.equal(table, 'operations_case_events'); return {
    async upsert(row, options) {
      assert.deepEqual(options, { onConflict: 'id', ignoreDuplicates: true });
      if (overrides.eventFailure) return { error: { message: 'Fictional write failure' } };
      if (!events.has(row.id)) events.set(row.id, row);
      return { error: null };
    },
  }; } };
  const handler = createVoiceWebhook({ env: { ...env, ...overrides.env }, now: () => now,
    supabase: () => sb, newRef: () => 'AAE-CALL-' + ++serial,
    createCase: async (_sb, input) => {
      if (overrides.caseFailure) throw new Error('Fictional failure');
      assert.equal(input.customerPhone, null); assert.equal(input.bookingId, null); assert.equal(input.easerId, null);
      if (!cases.has(input.sourceRef)) cases.set(input.sourceRef, { id: '33333333-3333-4333-8333-333333333333', ...input });
      return cases.get(input.sourceRef);
    } });
  async function invoke(event = fixture, headers = {}, rawOverride) {
    const raw = rawOverride || Buffer.from(JSON.stringify(event));
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp + '|'), raw]), privateKey).toString('base64');
    const req = { method: 'POST', headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature, ...headers },
      async *[Symbol.asyncIterator]() { yield raw; } };
    const res = response(); await handler(req, res); return res;
  }
  return { invoke, cases, events };
}
const h = voiceHarness();
await Promise.all([h.invoke(), h.invoke()]);
assert.equal(h.cases.size, 1); assert.equal(h.events.size, 1);
const earlier = structuredClone(fixture);
earlier.data.id = '44444444-4444-4444-8444-444444444444';
earlier.data.event_type = 'call.initiated'; earlier.data.occurred_at = new Date(now - 60000).toISOString();
assert.equal((await h.invoke(earlier)).statusCode, 200);
assert.equal(h.cases.size, 1); assert.equal(h.events.size, 2);
assert.doesNotMatch(JSON.stringify([...h.events.values()]), /MUST NOT STORE/);
for (const override of [{ env: { TELNYX_AI_VOICE_EVENTS_ENABLED: 'false' } }, { env: { VERCEL_ENV: 'preview' } },
  { env: { VERCEL_TARGET_ENV: 'preview' } }, { env: { TELNYX_AI_VOICE_CONNECTION_ID: '' } }]) {
  const disabled = voiceHarness(override);
  assert.equal((await disabled.invoke()).statusCode, 503); assert.equal(disabled.cases.size, 0);
}
assert.equal((await voiceHarness({ eventFailure: true }).invoke()).statusCode, 503);
assert.equal((await voiceHarness({ caseFailure: true }).invoke()).statusCode, 503);
assert.equal((await h.invoke(fixture, { 'telnyx-signature-ed25519': 'bad' })).statusCode, 400);
assert.equal((await h.invoke(fixture, { 'telnyx-timestamp': String(now / 1000 - 301) })).statusCode, 400);
assert.equal((await h.invoke(fixture, {}, Buffer.alloc(32769))).statusCode, 413);
assert.equal((await h.invoke(fixture, {}, Buffer.from('invalid'))).statusCode, 400);
const wrongConnection = structuredClone(fixture); wrongConnection.data.payload.connection_id = '987654321';
assert.equal((await h.invoke(wrongConnection)).statusCode, 403);
const invalidEvent = structuredClone(fixture); invalidEvent.data.id = 'not-a-provider-uuid';
assert.equal((await h.invoke(invalidEvent)).statusCode, 400);
assert.equal(verifyVoiceSignature({ raw: Buffer.from('x'), publicKey: '', signature: '', timestamp, now }), false);
const unknown = structuredClone(fixture); unknown.data.event_type = 'call.recording.saved';
assert.equal((await h.invoke(unknown)).body.ignored, true);

const chat = await read('api/chat.js');
const callbackCase = { source: 'system', source_ref: 'telnyx-ai:call_fixture' };
assert.match(soraCaseAttention(callbackCase, { attempts: 0 }), /no notification attempt/);
assert.match(soraCaseAttention(callbackCase, { unavailable: true }), /could not be loaded/);
assert.match(soraCaseAttention(callbackCase, { attempts: 1, latest: { status: 'failed' } }), /needs attention/);
assert.match(soraCaseAttention(callbackCase, { attempts: 1, latest: { status: 'provider_accepted' } }), /not confirmed/);
assert.equal(soraCaseAttention(callbackCase, { attempts: 1, latest: { status: 'delivered' } }), null);
assert.match(soraCaseAttention({ ...callbackCase, source_ref: 'telnyx-call:call_fixture' }), /Call history only/);
assert.equal(soraCaseAttention({ source: 'contact_form', source_ref: 'not-sora' }), null);
assert.match(await read('owner/assets/cases.js'), /esc\(item\.attention\)/);
const voiceReference = 'call_' + 'a'.repeat(64);
assert.deepEqual(relatedSoraSourceRefs({ source: 'system', source_ref: 'telnyx-ai:' + voiceReference }),
  ['telnyx-call:', 'telnyx-ai:', 'telnyx-ai-pro:'].map(prefix => prefix + voiceReference));
assert.deepEqual(relatedSoraSourceRefs({ source: 'system', source_ref: 'telnyx-ai:untrusted-selector' }), []);
assert.deepEqual(relatedSoraSourceRefs({ source: 'customer_report', source_ref: 'telnyx-ai:' + voiceReference }), []);
assert.doesNotMatch(chat, /online appointments are closed Sunday/);
assert.match(chat, /including Sunday, from 8 AM to 8 PM Central/);
console.log(`PASS: Sora handoff (${allItems.length} catalog items), quote guard, manual/Connect readiness, caller boundaries, signed call events and retry safety. All offline; no live booking/payment/call/email.`);
