import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupportHandler, validateSupportRequest, SUPPORT_TOPICS, supportHours } from '../api/ai/support.js';
import { getBookingCatalog } from '../api/_pricing.js';
import { createOperationCase } from '../api/_operation-cases.js';

globalThis.fetch = async () => { throw new Error('Network forbidden in Sora intake tests.'); };
const secret = 'fictional-test-secret-000000000000000000000000';
const catalog = getBookingCatalog();
const valid = {
  action: 'submit_request', callControlId: 'v3:fictional_intake_call_12345', callerRole: 'customer', topic: 'new_service',
  name: 'TEST - Local Customer', phone: '512-555-0100', email: 'customer@example.com', city: 'Austin',
  summary: 'TEST ONLY: Assemble a bed and treadmill in the upstairs room.',
  preferredCallbackTime: 'Monday afternoon if possible', detailsConfirmed: true, callbackConsent: true,
  bookingDetails: { services: ['Furniture Assembly', 'Fitness Equipment'],
    items: [{ service: 'Furniture Assembly', description: 'Queen bed', quantity: 1 },
      { service: 'Fitness Equipment', description: 'Treadmill', quantity: 1 }],
    address: '123 Fictional Example Lane, Unit B', postalCode: '78701', requestedDate: 'Next Friday, date to confirm',
    requestedWindow: 'Morning preferred', siteNotes: 'Second floor with stairs.', productNotes: 'New boxed products; hardware present.', readiness: 'ready' },
};
const pro = { action: 'submit_request', callControlId: 'v3:fictional_pro_call_12345', callerRole: 'service_pro',
  topic: 'earnings', name: 'TEST - Local Easer', phone: '512-555-0100', summary: 'TEST ONLY: Help understanding earnings for a completed job.',
  jobReference: 'AAE-FICTIONAL-JOB', detailsConfirmed: true, callbackConsent: true };
const clone = value => structuredClone(value);
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }

function harness(options = {}) {
  const calls = { cases: [], emails: [], events: [], connections: 0, limits: 0 };
  const saved = new Map();
  let serial = 0;
  const handler = createSupportHandler({
    env: { TELNYX_AI_INTAKE_ENABLED: 'true', TELNYX_AI_CALLBACKS_ENABLED: 'true', TELNYX_AI_SUPPORT_ENABLED: 'true',
      TELNYX_AI_TOOL_SECRET: secret, VERCEL_ENV: 'production', ...options.env },
    catalog: () => { if (options.catalogFails) throw new Error('Fake unavailable catalog'); return catalog; },
    supabase: () => { calls.connections++; return { fake: true }; }, newRef: () => `AAE-AI-LOCAL-${++serial}`,
    createCase: async (_sb, value) => {
      calls.cases.push(value);
      if (options.dbFails) throw new Error('Fake unavailable database');
      if (!saved.has(value.sourceRef)) saved.set(value.sourceRef, { id: `fake-case-${saved.size}`, case_ref: value.caseRef,
        description: value.description, customer_name: value.customerName, customer_phone: value.customerPhone });
      return saved.get(value.sourceRef);
    },
    email: async value => { calls.emails.push(value); if (options.emailFails) throw new Error('Fake unavailable email');
      return options.emailResult || { providerAccepted: true, logged: true }; },
    ownerAddress: () => 'owner@example.com', durableLimit: () => options.durable !== false,
    limit: async (key, mode) => { calls.limits++; assert.equal(key, 'telnyx-ai:intake'); assert.equal(mode, 'default');
      if (options.limitFails) throw new Error('Fake unavailable limiter'); return options.allowed !== false; },
    appendEvent: async (_sb, value) => { calls.events.push(value); if (options.eventFails) throw new Error('Fake unavailable timeline'); },
    now: () => new Date('2026-09-07T14:00:00Z'),
  });
  async function invoke(body = valid, request = {}) {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body, ...request }, res);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    return res;
  }
  return { calls, saved, invoke };
}

check(validateSupportRequest(valid, catalog).value.phone === '+15125550100', 'Phone normalization');
for (const city of ['Austin', 'Houston', 'San Antonio']) check(!validateSupportRequest({ ...valid, city }, catalog).error, city);
for (const service of Object.keys(catalog.subcategories)) {
  const data = { ...valid, bookingDetails: { services: [service] } };
  check(!validateSupportRequest(data, catalog).error, `Category ${service}`);
}
for (const [callerRole, topics] of Object.entries(SUPPORT_TOPICS)) {
  for (const topic of Object.keys(topics)) {
    const data = { ...pro, callerRole, topic };
    if (['new_service', 'custom_quote'].includes(topic)) data.bookingDetails = valid.bookingDetails;
    const h = harness();
    const response = await h.invoke(data);
    check(response.code === 200, `${callerRole}/${topic}`);
    check(h.calls.cases[0].caseType === topics[topic][1], 'Case type');
    check(h.calls.cases[0].severity === topics[topic][2], 'Case severity');
    check(h.calls.cases[0].bookingId === null && h.calls.cases[0].easerId === null, 'No unverified linking');
    check(h.calls.cases[0].customerName === (callerRole === 'customer' ? data.name : null), 'Pro not mislabeled as customer');
    for (const key of ['bookingCreated', 'appointmentConfirmed', 'paymentTaken', 'accountChanged', 'identityVerified', 'callbackTimeConfirmed']) check(response.data[key] === false, key);
  }
}

const newBooking = patch => ({ ...valid, bookingDetails: { ...valid.bookingDetails, ...patch } });
for (const data of [null, [], {}, { ...valid, action: 'pay' }, { ...valid, callbackConsent: 'true' }, { ...valid, detailsConfirmed: false },
  { ...valid, callControlId: '{{call_control_id}}' }, { ...valid, conversationId: 'fake_model_id_123' },
  { ...valid, callControlId: 'v3:short' }, { ...valid, callControlId: 'v3:' + 'a'.repeat(1001) },
  { ...valid, phone: '+44 2071234567' }, { ...valid, phone: '512-555-0100 ext 4' },
  { ...valid, topic: 'earnings' }, { ...pro, topic: 'new_service' }, { ...pro, bookingDetails: {} },
  { ...valid, summary: 'short' }, { ...valid, summary: 'x'.repeat(1201) }, { ...valid, name: {} },
  { ...valid, email: 'bad@@example.com' }, { ...valid, city: null }, { ...valid, activeJob: 'true' },
  { ...valid, bookingId: 'victim' }, { ...valid, easerId: 'victim' }, { ...valid, total: 0 }, { ...valid, payout: 100 },
  { ...valid, to: 'attacker@example.com' }, { ...valid, verified: true }, { ...valid, cardNumber: 'not allowed' },
  { ...valid, summary: 'Card number 4242 4242 4242 4242' }, { ...valid, summary: 'SSN 123-45-6789' },
  newBooking({ siteNotes: 'Gate code is 1234' }), newBooking({ productNotes: 'CVV: 123' }),
  newBooking({ postalCode: 'ABCDE' }), newBooking({ address: 'a'.repeat(251) }), newBooking({ readiness: 'yes' }),
  newBooking({ services: ['__proto__'] }), newBooking({ services: ['Furniture Assembly', 'Furniture Assembly'] }),
  newBooking({ items: [{ service: 'Other', description: 'A thing', quantity: 1 }] }),
  newBooking({ items: [{ service: 'Furniture Assembly', description: 'Bed', quantity: 1, price: 1 }] }),
  ...[0, -1, 100, 1.5, '1'].map(quantity => newBooking({ items: [{ service: 'Furniture Assembly', description: 'Bed', quantity }] })),
  newBooking({ items: Array(16).fill({ service: 'Furniture Assembly', description: 'Bed', quantity: 1 }) }),
]) {
  const h = harness(); const result = await h.invoke(data);
  check(result.code === 400, 'Invalid payload rejected');
  check(h.calls.connections === 0 && h.calls.emails.length === 0, 'Rejected before writes');
}
const tooLong = newBooking({ items: Array(15).fill({ service: 'Furniture Assembly', description: 'word '.repeat(20).trim(), quantity: 99 }),
  productNotes: 'word '.repeat(80).trim(), siteNotes: 'word '.repeat(60).trim(), address: 'a'.repeat(250) });
tooLong.summary = 'word '.repeat(240).trim(); tooLong.requestedOutcome = 'o'.repeat(200);
check(validateSupportRequest(tooLong, catalog).error?.includes('too long'), 'No silent truncation beyond case limit');

const optional = harness(); const minimal = { ...valid, email: undefined, city: undefined, bookingDetails: { services: ['Furniture Assembly'] } };
check((await optional.invoke(minimal)).code === 200, 'Incomplete but consented intake saved');
check(optional.calls.cases[0].description.includes('Still to clarify: city; email (optional); service address; ZIP code; preferred service date; preferred service window; item details/quantities; site/product readiness'), 'Missing details visible');
const active = harness(); await active.invoke({ ...pro, activeJob: true });
check(active.calls.cases[0].severity === 'high', 'Active-job escalation');
const duplicate = harness(); const [one, two] = await Promise.all([duplicate.invoke(), duplicate.invoke()]);
check(one.data.ref === two.data.ref && duplicate.saved.size === 1 && duplicate.calls.emails.length === 1, 'Concurrent retry produces one case/email');
check((await duplicate.invoke({ ...valid, summary: 'Different confirmed request details' })).code === 409, 'Changed retry conflicts');
check((await duplicate.invoke({ ...pro, callControlId: valid.callControlId })).code === 409, 'Role switch cannot duplicate same call');
check(duplicate.calls.emails.length === 1 && duplicate.saved.size === 1, 'Conflict cannot overwrite or notify');
check(duplicate.calls.emails[0].to === 'owner@example.com', 'Fixed owner recipient');
check(duplicate.calls.emails[0].meta.operationCaseId === duplicate.calls.events[0].caseId, 'Email and timeline linked to same case');
check(duplicate.calls.events[0].metadata.deliveryConfirmed === false, 'Provider accepted is not delivered');
for (const value of [duplicate.calls.cases[0], active.calls.cases[0]]) {
  let rpc;
  await createOperationCase({ rpc: async (name, args) => {
    rpc = { name, args };
    return { data: [{ id: 'local-only-rpc', case_ref: args.p_case_ref, description: args.p_description }] };
  } }, value);
  check(rpc.name === 'create_operations_case_v1' && rpc.args.p_description === value.description, 'Actual Cases helper retains full description');
  check(rpc.args.p_booking_id === null && rpc.args.p_easer_id === null, 'Actual RPC leaves private records unlinked');
}
const escaped = harness(); await escaped.invoke({ ...pro, summary: '<script>alert("fictional")</script> customer issue' });
check(!escaped.calls.emails[0].html.includes('<script>') && escaped.calls.emails[0].html.includes('&lt;script&gt;'), 'HTML escaped');

for (const env of [{ TELNYX_AI_SUPPORT_ENABLED: undefined }, { TELNYX_AI_SUPPORT_ENABLED: 'false' }, { TELNYX_AI_CALLBACKS_ENABLED: 'false' },
  { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, { VERCEL_TARGET_ENV: 'staging' }, { TELNYX_AI_INTAKE_ENABLED: 'false' }]) {
  const h = harness({ env }); check((await h.invoke()).code === 503 && h.calls.connections === 0, 'Fail-closed environment gate');
}
for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: ['Bearer ' + secret] }]) {
  const h = harness(); check((await h.invoke(valid, { headers })).code === 401 && h.calls.connections === 0, 'Authentication');
}
check((await harness({ env: { TELNYX_AI_TOOL_SECRET: 'short' } }).invoke()).code === 401, 'Weak configured secret disabled');
check((await harness().invoke(valid, { method: 'GET' })).code === 405, 'POST only');
for (const [options, expected] of [[{ durable: false }, 503], [{ allowed: false }, 429], [{ limitFails: true }, 503], [{ dbFails: true }, 503]]) {
  const h = harness(options); check((await h.invoke()).code === expected && h.calls.emails.length === 0, 'Outage never emails unsaved request');
}
for (const options of [{ emailFails: true }, { emailResult: { ok: false, logged: true } }, { eventFails: true }]) {
  const h = harness(options); check((await h.invoke()).code === 200 && h.saved.size === 1, 'Notification failure cannot undo durable case');
  if (!options.eventFails) check(h.calls.events[0].metadata.providerAccepted === false, 'Failed alert visible');
}
const outage = harness({ catalogFails: true });
check((await outage.invoke()).code === 503, 'Catalog outage blocks new-service categorization');
check((await outage.invoke(pro)).code === 200, 'Easer support survives catalog outage');
check((await outage.invoke({ ...pro, callControlId: 'v3:fictional_customer_support_999', callerRole: 'customer', topic: 'payment' })).code === 200, 'Existing-customer support survives catalog outage');
const options = harness(); const info = await options.invoke({ action: 'support_options' });
check(info.code === 200 && info.data.requestsEnabled === true && options.calls.connections === 0, 'Options read only');
check(info.data.services.length === 7 && info.data.topics.customer.length === 9 && info.data.topics.service_pro.length === 9, 'Catalog and all topics');
check((await options.invoke({ action: 'support_options', id: 'victim' })).code === 400, 'Options reject extra fields');
check((await harness({ env: { TELNYX_AI_SUPPORT_ENABLED: 'false' } }).invoke({ action: 'support_options' })).data.requestsEnabled === false, 'Options report disabled truth');
for (const [date, expected] of [['2026-09-07T11:59:00Z', false], ['2026-09-07T12:00:00Z', true], ['2026-09-07T21:59:00Z', true],
  ['2026-09-07T22:00:00Z', false], ['2026-09-05T17:59:00Z', true], ['2026-09-05T18:00:00Z', false],
  ['2026-09-06T15:00:00Z', false], ['2026-12-07T12:59:00Z', false], ['2026-12-07T13:00:00Z', true]]) {
  check(supportHours(new Date(date)).humanSupportOpen === expected, `Chicago hours/DST ${date}`);
}

const contract = JSON.parse(await readFile(new URL('../business-artifacts/telnyx-sora-intake-tool-contract-2026-09-06.json', import.meta.url), 'utf8'));
const tool = contract.tools.find(item => item.name === 'save_support_request');
const nodes = contract.workflow_attachment_plan.nodes;
check(nodes.every(node => node.instructions_mode === 'append' && node.tools_mode === 'replace'), 'Target node scopes retain new global safety and replace old tools');
check(!nodes.find(node => node.id === 'sora_receptionist').tool_names.includes('save_support_request'), 'Entry cannot submit before routing');
check(nodes.filter(node => node.id !== 'sora_receptionist').every(node => node.tool_names.includes('save_support_request')), 'Both support paths get the new save tool');
check(tool.preset_body_fields.callControlId === '{{call_control_id}}' && !Object.hasOwn(tool.body_parameters.properties, 'callControlId'), 'Provider ID not model-controlled');
check(!Object.hasOwn(tool.body_parameters.properties, 'action') && tool.preset_body_fields.action === 'submit_request', 'Action preset');
assert.deepEqual(tool.body_parameters.properties.bookingDetails.properties.services.items.enum, Object.keys(catalog.subcategories));
assert.deepEqual(new Set(tool.body_parameters.properties.topic.enum), new Set(Object.values(SUPPORT_TOPICS).flatMap(topics => Object.keys(topics))));
for (const field of ['bookingId', 'easerId', 'total', 'payout', 'to', 'cardNumber', 'password']) check(!Object.hasOwn(tool.body_parameters.properties, field), 'No privileged tool field');
const prompt = await readFile(new URL('../business-artifacts/telnyx-sora-intake-only-prompt-2026-09-06.txt', import.meta.url), 'utf8');
for (const phrase of ['You are not a DIY coach', 'Role selection is not identity verification', 'Only after success=true',
  'Are those details correct, and may our team call you about this request?', 'never a caller-provided number',
  'Full phone booking and payment collection are paused', 'Do not claim the correction was saved', 'Do not infer consent from silence']) check(prompt.includes(phrase), phrase);
const source = await readFile(new URL('../api/ai/support.js', import.meta.url), 'utf8');
check(!/from\s+['"][^'"]*(?:stripe|booking-continuation|dispatch|easer-readiness)/.test(source), 'No financial/dispatch dependency');
console.log(`PASS Sora intake-only: ${checks} checks; 18 role/topic workflows, full/incomplete customer intake, Easer/owner truth, replay, auth, privacy, outages and Central hours. No live requests.`);
