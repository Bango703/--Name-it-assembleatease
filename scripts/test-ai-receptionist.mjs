import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createReceptionistHandler, receptionistCatalog, validateReceptionistIntake } from '../api/ai/receptionist.js';
import { getBookingCatalog } from '../api/_pricing.js';

// Never use live services in this suite, even if credentials exist in the shell.
globalThis.fetch = async () => { throw new Error('Network access forbidden in receptionist tests'); };
const secret = 'fictional-local-test-secret-only-000000000000000';
const catalog = getBookingCatalog();
const services = receptionistCatalog(catalog);
assert.deepEqual(services.map(s => s.service), Object.keys(catalog.subcategories));
assert.equal(services.length, 7);
for (const service of services) {
  const url = new URL(service.bookingUrl);
  assert.equal(url.origin, 'https://www.assembleatease.com');
  assert.equal(url.pathname, '/book');
  assert.equal(url.searchParams.get('service'), service.service);
  assert.equal(url.searchParams.get('utm_source'), 'sora');
  const expectedItems = catalog.subcategories[service.service].flatMap(g => g.items.map(i => i.name));
  assert.deepEqual(service.groups.flatMap(g => g.items.map(i => i.name)), Array.from(expectedItems));
  assert.doesNotMatch(JSON.stringify(service), /"price"|"total"|"fee"/);
}
assert.equal(services.find(s => s.service === 'Other').label, 'Custom project / not sure');
assert.equal(services.find(s => s.service === 'Furniture Assembly').groups.some(g => /cardio|strength/i.test(g.name)), false);
const bookingPage = await readFile(new URL('../book.html', import.meta.url), 'utf8');
const resolverStart = bookingPage.indexOf('function normalizeServiceToken(');
const resolverEnd = bookingPage.indexOf('function getSelectedItemLabel(', resolverStart);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
const resolverContext = { document: { querySelectorAll: () => [] } };
vm.runInNewContext(bookingPage.slice(resolverStart, resolverEnd), resolverContext, { timeout: 1000 });
for (const service of services) {
  assert.equal(resolverContext.resolveServiceSelection(new URL(service.bookingUrl).searchParams.get('service')), service.service);
}

const valid = {
  action: 'request_callback', conversationId: 'conv_fictional_123456', service: 'Furniture Assembly',
  name: 'Test Customer', phone: '(512) 555-0100', city: 'Austin', project: 'One queen bed frame to assemble.',
  preferredTime: 'Next Tuesday morning, if available', callbackConsent: true, detailsConfirmed: true,
};
assert.equal(validateReceptionistIntake(valid).value.phone, '+15125550100');
for (const city of ['Austin', 'Houston', 'San Antonio']) assert.ok(validateReceptionistIntake({ ...valid, city }).value);
for (const bad of [
  { callbackConsent: false }, { detailsConfirmed: false }, { callbackConsent: 'true' },
  { service: 'Made up service' }, { service: '__proto__' }, { phone: '+44 2071234567' },
  { phone: '512-555-0100 ext 123' }, { project: 'short' }, { conversationId: '../escape' },
  { name: {} }, { project: 'x'.repeat(1501) }, { city: '' },
  { bookingId: 'victim-booking' }, { total: 1 }, { payout: 100 }, { to: 'attacker@example.com' },
]) assert.ok(validateReceptionistIntake({ ...valid, ...bad }).error, JSON.stringify(bad));

function harness(options = {}) {
  const calls = { cases: [], events: [], emails: [] };
  const saved = new Map();
  let serial = 0;
  const env = { TELNYX_AI_INTAKE_ENABLED: 'true', TELNYX_AI_TOOL_SECRET: secret, ...options.env };
  const handler = createReceptionistHandler({
    env, catalog: () => catalog,
    supabase: () => ({ marker: 'fake-supabase-only' }),
    newRef: () => `AAE-AI-LOCAL-${++serial}`,
    createCase: async (_sb, input) => {
      calls.cases.push(input);
      if (options.databaseFails) throw new Error('Fake database unavailable');
      if (!saved.has(input.sourceRef)) saved.set(input.sourceRef, {
        id: `case-${saved.size + 1}`, case_ref: input.caseRef, description: input.description,
        customer_phone: input.customerPhone, customer_name: input.customerName,
      });
      return saved.get(input.sourceRef);
    },
    email: async input => {
      calls.emails.push(input);
      if (options.emailThrows) throw new Error('Fake email setup missing');
      return options.emailResult || { ok: true, providerAccepted: true, logged: true };
    },
    ownerAddress: () => 'owner@example.com',
    durableLimit: () => options.hasLimit !== false,
    limit: async () => {
      if (options.limitFails) throw new Error('Fake limiter unavailable');
      return options.allowRequest !== false;
    },
    appendEvent: async (_sb, input) => {
      calls.events.push(input);
      if (options.eventFails) throw new Error('Fake event failure');
      return { id: 'fake-event' };
    },
  });
  async function invoke(body = valid, request = {}) {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(data) { this.body = data; return this; } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body, ...request }, res);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    return res;
  }
  return { invoke, calls, saved };
}

for (const env of [{ TELNYX_AI_INTAKE_ENABLED: undefined }, { TELNYX_AI_INTAKE_ENABLED: 'false' }]) {
  const h = harness({ env });
  assert.equal((await h.invoke()).statusCode, 503);
  assert.equal(h.calls.cases.length, 0);
}
for (const authorization of [undefined, `Bearer ${secret}bad`, 'Basic xyz', ['Bearer', secret]]) {
  const h = harness();
  assert.equal((await h.invoke(valid, { headers: { authorization } })).statusCode, 401);
  assert.equal(h.calls.emails.length, 0);
}
assert.equal((await harness({ env: { TELNYX_AI_TOOL_SECRET: 'short' } }).invoke()).statusCode, 401);
assert.equal((await harness().invoke(valid, { method: 'GET' })).statusCode, 405);
assert.equal((await harness().invoke({ ...valid, action: 'complete_booking' })).statusCode, 400);
const catalogHarness = harness();
assert.equal((await catalogHarness.invoke({ action: 'catalog' })).body.services.length, 7);
assert.equal(catalogHarness.calls.cases.length, 0);
assert.equal((await catalogHarness.invoke({ action: 'catalog', service: 'Fitness Equipment' })).body.services.length, 1);
assert.equal((await catalogHarness.invoke({ action: 'catalog', service: 'Fake' })).statusCode, 400);
assert.equal((await catalogHarness.invoke({ action: 'catalog', price: 1 })).statusCode, 400);
for (const [options, code] of [[{ hasLimit: false }, 503], [{ limitFails: true }, 503], [{ allowRequest: false }, 429]]) {
  const limited = harness(options);
  assert.equal((await limited.invoke()).statusCode, code);
  assert.equal(limited.calls.cases.length, 0);
}

const h = harness();
const received = await h.invoke();
assert.equal(received.statusCode, 200);
assert.equal(received.body.bookingCreated, false);
assert.equal(received.body.status, 'received');
assert.doesNotMatch(JSON.stringify(received.body), /owner@example|providerAccepted|case-1/);
assert.equal(h.calls.cases[0].source, 'system');
assert.equal(h.calls.cases[0].sourceRef, `telnyx-ai:${valid.conversationId}`);
assert.equal(h.calls.cases[0].bookingId, undefined);
assert.equal(h.calls.cases[0].metadata.callbackConsent, true);
assert.equal(h.calls.emails[0].to, 'owner@example.com');
assert.equal(h.calls.emails[0].meta.operationCaseId, 'case-1');
assert.equal(h.calls.emails[0].meta.recipientType, 'owner');
assert.equal(h.calls.events[0].metadata.deliveryConfirmed, false);
assert.equal((await h.invoke()).body.ref, received.body.ref);
assert.equal(h.saved.size, 1);
assert.equal(h.calls.emails.length, 1);
assert.equal((await h.invoke({ ...valid, phone: '713-555-0100' })).statusCode, 409);
assert.equal(h.calls.emails.length, 1);
const parallel = harness();
await Promise.all([parallel.invoke(), parallel.invoke()]);
assert.equal(parallel.saved.size, 1);
assert.equal(parallel.calls.emails.length, 1);

const unavailable = harness({ databaseFails: true });
assert.equal((await unavailable.invoke()).statusCode, 503);
assert.equal(unavailable.calls.emails.length, 0);
for (const options of [{ emailThrows: true }, { emailResult: { ok: false } }, { emailResult: { ok: true, suppressed: true } }]) {
  const failure = harness(options);
  assert.equal((await failure.invoke()).body.success, true);
  assert.equal(failure.saved.size, 1);
  assert.equal(failure.calls.events[0].metadata.providerAccepted, false);
  assert.equal(failure.calls.events[0].metadata.deliveryConfirmed, false);
}
const eventFailure = harness({ eventFails: true });
assert.equal((await eventFailure.invoke()).body.success, true);
assert.equal(eventFailure.saved.size, 1);
const html = harness();
await html.invoke({ ...valid, project: '<script>alert(1)</script> assembly request' });
assert.doesNotMatch(html.calls.emails[0].html, /<script>/);

const completion = await readFile(new URL('../api/booking/assembler-complete.js', import.meta.url), 'utf8');
assert.match(completion, /meta: \{ bookingId: booking.id, notificationType: 'owner_completion', recipientType: 'owner' \}/);
assert.match(completion, /Job completion was saved, but the owner completion alert failed/);
assert.match(completion, /Offline job completion was saved, but the owner completion alert failed/);
const completionLogs = completion.match(/await logActivity\(sb, \{\s+bookingId: booking.id,\s+eventType: 'completed'/g) || [];
assert.equal(completionLogs.length, 2, 'Both Easer completion paths must await their timeline');
console.log('PASS: canonical services, default-off gate, tool auth, caller confirmation, owner-case persistence, retries, failure visibility, no booking/payment actions, and completion linkage.');
