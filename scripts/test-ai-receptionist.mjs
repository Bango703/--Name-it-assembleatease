import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createReceptionistHandler, receptionistCatalog, validateReceptionistIntake } from '../api/ai/receptionist.js';
import { getBookingCatalog } from '../api/_pricing.js';
import { validateProSupportIntake } from '../api/ai/_pro-support-intake.js';

// Never use live services in this suite, even if credentials exist in the shell.
globalThis.fetch = async () => { throw new Error('Network access forbidden in receptionist tests'); };
const secret = 'fictional-local-test-secret-only-000000000000000';
const catalog = getBookingCatalog();
const services = receptionistCatalog(catalog);
const receptionistPrompt = await readFile(new URL('../business-artifacts/telnyx-sora-receptionist-prompt-2026-09-06.txt', import.meta.url), 'utf8');
assert.match(receptionistPrompt, /You are not a DIY coach\./);
assert.match(receptionistPrompt, /This catalog check is required, not optional\./);
assert.match(receptionistPrompt, /Do not end a booking enquiry by only giving a website address\./);
assert.match(receptionistPrompt, /Are those details correct, and may our team call you about this request\?/);
assert.match(receptionistPrompt, /Only after request_callback returns success=true/);
assert.match(receptionistPrompt, /Are you a customer looking for service, or a service pro\?/);
assert.match(receptionistPrompt, /Selecting a role is not identity verification/);
assert.match(receptionistPrompt, /CUSTOMER PATH/);
assert.match(receptionistPrompt, /SERVICE PRO PATH/);
assert.match(receptionistPrompt, /Never put a service pro through the customer project interview\./);
assert.match(receptionistPrompt, /These are support hours, not appointment availability\./);
assert.doesNotMatch(receptionistPrompt, /Sunday is closed for appointments\./);
assert.match(receptionistPrompt, /Do not disguise a Service Pro request as a furniture project/);
assert.match(receptionistPrompt, /You do not have a verified Service Pro account tool\./);
assert.match(receptionistPrompt, /Never request card numbers, CVV, bank details/);
assert.match(receptionistPrompt, /A priced item does not make accompanying quote-only work approved or priced\./);
const flow = JSON.parse(await readFile(new URL('../business-artifacts/telnyx-sora-two-path-workflow-2026-09-06.json', import.meta.url), 'utf8'));
const nodes = new Map(flow.nodes.map(node => [node.id, node]));
assert.equal(nodes.size, 3);
assert.ok(nodes.has(flow.start_node_id));
assert.equal(flow.edges.length, 4);
assert.equal(new Set(flow.edges.map(edge => edge.id)).size, 4);
for (const edge of flow.edges) {
  assert.ok(nodes.has(edge.start_node_id));
  assert.ok(nodes.has(edge.target.node_id));
  assert.equal(edge.target.type, 'node');
  assert.equal(edge.condition.type, 'llm');
  assert.ok(edge.condition.prompt.length > 30);
}
for (const node of flow.nodes) {
  assert.equal(node.instructions_mode, 'append'); // Retain global privacy/safety boundaries.
  assert.deepEqual(node.tools, []); // No new inline tools or payment capability.
}
assert.equal(nodes.get('sora_receptionist').tools_mode, 'replace');
assert.deepEqual(nodes.get('sora_receptionist').shared_tool_ids, [
  'tool-568f3d9b-9693-4103-83a4-60ad2f3c8f58', 'tool-41bb44a8-6d41-4008-8d1a-debc51f63298',
  'tool-a193faea-60da-436d-ad92-6c866c19b9f7', 'tool-c197145f-507c-4aae-81af-e27119417232',
]); // Read-only catalog is needed even before the first role transition.
assert.equal(nodes.get('sora_service_pro').tools_mode, 'replace');
assert.deepEqual(nodes.get('sora_service_pro').shared_tool_ids, [
  'tool-a193faea-60da-436d-ad92-6c866c19b9f7', 'tool-c197145f-507c-4aae-81af-e27119417232',
]); // Only existing fixed transfer and hangup; customer callback is unavailable.
assert.equal(nodes.get('sora_customer').tools_mode, 'append');
assert.match(nodes.get('sora_customer').instructions, /call get_service_catalog/);
assert.match(nodes.get('sora_service_pro').instructions, /Do not use customer callback intake/);
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
const { conversationId: _unusedConversationId, ...voiceInput } = valid;
const voice = { ...voiceInput, callControlId: 'v3:fictional_call_control_123456' };
assert.match(validateReceptionistIntake(voice).value.conversationId, /^call_[a-f0-9]{64}$/);
assert.equal(validateReceptionistIntake(voice).value.conversationId, validateReceptionistIntake(voice).value.conversationId);
assert.notEqual(validateReceptionistIntake(voice).value.conversationId,
  validateReceptionistIntake({ ...voice, callControlId: 'v3:another_fictional_call_123456' }).value.conversationId);
for (const callControlId of ['{{call_control_id}}', '', 'v3:short', 'v3:' + 'a'.repeat(1001), 123, 'v3:bad id with spaces']) {
  assert.ok(validateReceptionistIntake({ ...voiceInput, callControlId }).error);
}
assert.ok(validateReceptionistIntake({ ...valid, callControlId: voice.callControlId }).error);
for (const city of ['Austin', 'Houston', 'San Antonio']) assert.ok(validateReceptionistIntake({ ...valid, city }).value);
for (const bad of [
  { callbackConsent: false }, { detailsConfirmed: false }, { callbackConsent: 'true' },
  { service: 'Made up service' }, { service: '__proto__' }, { phone: '+44 2071234567' },
  { phone: '512-555-0100 ext 123' }, { project: 'short' }, { conversationId: '../escape' },
  { name: {} }, { project: 'x'.repeat(1501) }, { city: '' },
  { bookingId: 'victim-booking' }, { total: 1 }, { payout: 100 }, { to: 'attacker@example.com' },
]) assert.ok(validateReceptionistIntake({ ...valid, ...bad }).error, JSON.stringify(bad));

function harness(options = {}) {
  const calls = { cases: [], events: [], emails: [], databaseConnections: 0, rateLimits: 0 };
  const saved = new Map();
  let serial = 0;
  const env = {
    TELNYX_AI_INTAKE_ENABLED: 'true', TELNYX_AI_TOOL_SECRET: secret,
    TELNYX_AI_CALLBACKS_ENABLED: 'true', VERCEL_ENV: 'production',
    ...options.env,
  };
  const handler = createReceptionistHandler({
    env, catalog: () => { if (options.catalogFails) throw new Error('Fake catalog failure'); return catalog; },
    supabase: () => { calls.databaseConnections++; return { marker: 'fake-supabase-only' }; },
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
      calls.rateLimits++;
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
// Simulate production credentials being inherited by preview: not even the
// limiter, database client or email adapter may be touched by a callback test.
for (const env of [
  { TELNYX_AI_CALLBACKS_ENABLED: undefined },
  { TELNYX_AI_CALLBACKS_ENABLED: 'false' },
  { TELNYX_AI_CALLBACKS_ENABLED: 'TRUE' },
  { VERCEL_ENV: 'preview' },
  { VERCEL_ENV: 'development' },
  { VERCEL_ENV: undefined },
  { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'preview' },
  { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' },
]) {
  const blocked = harness({ env });
  const catalogResponse = await blocked.invoke({ action: 'catalog' });
  assert.equal(catalogResponse.statusCode, 200);
  assert.equal(catalogResponse.body.callbackRequestsEnabled, false);
  const response = await blocked.invoke();
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.bookingCreated, false);
  assert.equal(blocked.calls.databaseConnections, 0);
  assert.equal(blocked.calls.rateLimits, 0);
  assert.equal(blocked.calls.cases.length, 0);
  assert.equal(blocked.calls.emails.length, 0);
  assert.equal(blocked.calls.events.length, 0);
}
const catalogHarness = harness();
assert.equal((await catalogHarness.invoke({ action: 'catalog' })).body.services.length, 7);
assert.equal((await catalogHarness.invoke({ action: 'catalog' })).body.callbackRequestsEnabled, true);
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

const pro = {
  action: 'request_pro_support', callControlId: 'v3:fictional_pro_call_123456',
  name: 'Test Pro', phone: '713-555-0100', city: 'Houston', topic: 'application',
  issue: 'I need help continuing my Easer application.', preferredTime: 'Tomorrow morning if possible',
  detailsConfirmed: true, callbackConsent: true,
};
const proEnv = { TELNYX_AI_PRO_SUPPORT_ENABLED: 'true' };
assert.equal(validateProSupportIntake(pro).value.phone, '+17135550100');
for (const bad of [
  { topic: '__proto__' }, { topic: 'approve_me' }, { issue: 'short' },
  { callbackConsent: false }, { detailsConfirmed: 'true' }, { phone: '+44 2071234567' },
  { conversationId: 'conflicting_provider_ref' }, { callControlId: '{{call_control_id}}' },
  { name: {} }, { city: '' }, { preferredTime: [] }, { role: 'owner' }, { verified: true },
  { service: 'Furniture Assembly' }, { bookingId: 'victim-booking' }, { easerId: 'victim-pro' },
  { payout: 100 }, { to: 'attacker@example.com' }, { severity: 'critical' },
  { issue: 'My fictional card is 4111 1111 1111 1111.' }, { issue: 'Fictional identity number 123-45-6789.' },
]) assert.ok(validateProSupportIntake({ ...pro, ...bad }).error, JSON.stringify(Object.keys(bad)));
for (const env of [
  {}, { TELNYX_AI_PRO_SUPPORT_ENABLED: 'false' }, { TELNYX_AI_PRO_SUPPORT_ENABLED: 'TRUE' },
  { ...proEnv, TELNYX_AI_CALLBACKS_ENABLED: 'false' }, { ...proEnv, VERCEL_ENV: 'preview' },
  { ...proEnv, VERCEL_ENV: 'development' }, { ...proEnv, VERCEL_TARGET_ENV: 'preview' },
]) {
  const gated = harness({ env });
  assert.equal((await gated.invoke(pro)).statusCode, 503);
  assert.equal((await gated.invoke({ action: 'support_options' })).body.proSupportRequestsEnabled, false);
  assert.equal(gated.calls.databaseConnections, 0);
  assert.equal(gated.calls.rateLimits, 0);
  assert.equal(gated.calls.emails.length, 0);
}
const proOptions = harness({ env: proEnv, catalogFails: true });
const opts = await proOptions.invoke({ action: 'support_options' });
assert.equal(opts.statusCode, 200);
assert.equal(opts.body.topics.length, 6);
assert.equal(opts.body.accountAccessEnabled, false);
assert.equal(proOptions.calls.cases.length, 0);
assert.equal((await proOptions.invoke({ action: 'support_options', role: 'owner' })).statusCode, 400);
assert.equal((await proOptions.invoke(pro, { headers: {} })).statusCode, 401);
for (const [options, code] of [[{ hasLimit: false }, 503], [{ limitFails: true }, 503], [{ allowRequest: false }, 429], [{ databaseFails: true }, 503]]) {
  const blocked = harness({ ...options, env: proEnv });
  assert.equal((await blocked.invoke(pro)).statusCode, code);
  assert.equal(blocked.calls.emails.length, 0);
}
const savedPro = harness({ env: proEnv, catalogFails: true });
const proResult = await savedPro.invoke(pro);
assert.equal(proResult.statusCode, 200);
assert.equal(proResult.body.accountChanged, false);
assert.equal(proResult.body.identityVerified, false);
assert.equal(proResult.body.bookingCreated, false);
assert.doesNotMatch(JSON.stringify(proResult.body), /owner@example|case-1|713|providerAccepted/);
const proCase = savedPro.calls.cases[0];
assert.match(proCase.sourceRef, /^telnyx-ai-pro:call_[a-f0-9]{64}$/);
assert.match(proCase.subject, /Sora Service Pro: Application help/);
assert.equal(proCase.customerName, null);
assert.equal(proCase.customerPhone, null);
assert.equal(proCase.easerId, null);
assert.equal(proCase.bookingId, null);
assert.equal(proCase.metadata.identityVerified, false);
assert.equal(proCase.metadata.callerRole, 'service_pro');
assert.match(proCase.description, /Test Pro/);
assert.equal(savedPro.calls.emails[0].to, 'owner@example.com');
assert.equal(savedPro.calls.emails[0].meta.notificationType, 'ai_pro_support_owner');
assert.equal(savedPro.calls.emails[0].meta.operationCaseId, 'case-1');
assert.equal((await savedPro.invoke(pro)).body.ref, proResult.body.ref);
assert.equal(savedPro.calls.emails.length, 1);
assert.equal((await savedPro.invoke({ ...pro, issue: 'A different issue after the confirmed request.' })).statusCode, 409);
for (const topic of opts.body.topics) {
  const scope = harness({ env: proEnv });
  assert.equal((await scope.invoke({ ...pro, topic: topic.topic })).statusCode, 200);
  assert.ok(['support', 'account', 'safety', 'payment'].includes(scope.calls.cases[0].caseType));
}
const concurrentPro = harness({ env: proEnv });
await Promise.all([concurrentPro.invoke(pro), concurrentPro.invoke(pro)]);
assert.equal(concurrentPro.saved.size, 1);
assert.equal(concurrentPro.calls.emails.length, 1);
for (const options of [{ emailThrows: true }, { emailResult: { ok: false } }, { eventFails: true }]) {
  const failure = harness({ env: proEnv, ...options });
  assert.equal((await failure.invoke(pro)).body.success, true);
  assert.equal(failure.saved.size, 1);
  assert.equal(failure.calls.events[0].metadata.deliveryConfirmed, false);
}
const proHtml = harness({ env: proEnv });
await proHtml.invoke({ ...pro, issue: '<script>alert(1)</script> application issue' });
assert.doesNotMatch(proHtml.calls.emails[0].html, /<script>/);

const completion = await readFile(new URL('../api/booking/assembler-complete.js', import.meta.url), 'utf8');
assert.match(completion, /meta: \{ bookingId: booking.id, notificationType: 'owner_completion', recipientType: 'owner' \}/);
assert.match(completion, /Job completion was saved, but the owner completion alert failed/);
assert.match(completion, /Offline job completion was saved, but the owner completion alert failed/);
const completionLogs = completion.match(/await logActivity\(sb, \{\s+bookingId: booking.id,\s+eventType: 'completed'/g) || [];
assert.equal(completionLogs.length, 2, 'Both Easer completion paths must await their timeline');
console.log('PASS: canonical services, default-off gate, tool auth, caller confirmation, owner-case persistence, retries, failure visibility, no booking/payment actions, and completion linkage.');
