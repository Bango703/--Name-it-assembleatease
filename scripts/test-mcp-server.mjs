#!/usr/bin/env node
// The AI assistant connector (api/mcp.js, api/_mcp-tools.js), held to:
//   1. the MCP Streamable HTTP rules a real client depends on
//   2. the directory rules Claude and ChatGPT review against (titles, read-only
//      annotations, short names, no instructions aimed at the model)
//   3. one truth: every price is the checkout engine's, every search the booking
//      page's rule, every date and window the booking API's, every policy the
//      sentence llms.txt carries
//   4. no writes: the connector cannot book, charge, message or touch a booking
//   5. attribution: a booking from an assistant's link lands in the owner's
//      "AI assistant" channel
// scripts/test-mcp-sdk-client.mjs drives the same handler with the official
// MCP client library.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS, SERVER_INFO, assistantFamily, originAllowed, sessionFamily } from '../api/mcp.js';
import { callTool, toolDefinitions, ZONE_SAMPLE_ZIPS, bookingUrl, ASSISTANT_SOURCES, SITE } from '../api/_mcp-tools.js';
import { calculateBookingPricing, getBookingCatalog } from '../api/_pricing.js';
import { catalogSearch } from '../api/_catalog-search.js';
import { trueFromPrice } from './lib/catalog-prices.mjs';
import { openBookingSlots, BOOKING_TIME_SLOTS } from '../api/booking/_booking-slots.js';
import { bookingWindow } from '../api/booking/_booking-window.js';
import {
  AUTOMATIC_DISPATCH_ZIPS, AUTOMATIC_DISPATCH_ZIP_PREFIXES, CANCELLATION_POLICY, SERVICE_CALL_ZONES, getServiceCallZone,
} from '../api/_source-of-truth.js';
import { bookingFacts, organization } from '../api/_public-facts.js';
import { cleanAcquisitionAttribution } from '../api/_attribution.js';
import { acquisitionForBooking } from '../api/owner/_acquisition-report.js';
import { findCustomerLanguageViolations, findJustifyingCopy } from '../api/_customer-language.js';

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}`); console.error(error); process.exitCode = 1; }
}

const catalog = getBookingCatalog();
const services = Object.keys(catalog.subcategories).filter((s) => s !== 'Other');
const allItems = services.flatMap((service) => catalog.subcategories[service].flatMap((g) => g.items.map((item) => ({ service, group: g.group, item }))));
const mainItems = allItems.filter((r) => !r.item.addon && !r.item.customQuote && r.item.price > 0);
const NOW = new Date('2026-11-18T15:00:00Z'); // 9:00 AM Central on a Wednesday

// ── a Vercel-shaped request/response pair ────────────────────────────────────
function call(handler, { method = 'POST', body, headers = {} } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
  const req = { method, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body, socket: { remoteAddress: '203.0.113.9' } };
  return Promise.resolve(handler(req, res)).then(() => res);
}
function harness(overrides = {}) {
  const usage = [];
  const limits = [];
  const handler = createMcpHandler({
    rateLimiter: async (ip, type) => { limits.push([ip, type]); return true; },
    recordToolCall: async (row) => { usage.push(row); },
    now: () => NOW,
    newSessionId: () => '11111111-2222-4333-8444-555555555555',
    ...overrides,
  });
  return { handler, usage, limits };
}
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
async function tool(handler, name, args, headers = {}) {
  const res = await call(handler, { body: rpc('tools/call', { name, arguments: args }), headers });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.result, `tools/call ${name} returned an error: ${JSON.stringify(res.body.error)}`);
  return res.body.result;
}

// ── 1. transport and lifecycle ──────────────────────────────────────────────
await check('initialize returns the version the client asked for, or the newest', async () => {
  const { handler } = harness();
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const res = await call(handler, { body: rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result.protocolVersion, version);
  }
  const res = await call(handler, { body: rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } }) });
  assert.equal(res.body.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.deepEqual(res.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.body.result.serverInfo.name, 'assembleatease');
  assert.equal(res.body.result.serverInfo.title, 'AssembleAtEase');
  assert.match(res.body.result.instructions, /do not create bookings or take payment/);
});

await check('the server icon exists in the repo', () => {
  for (const icon of SERVER_INFO.icons) {
    const path = new URL(icon.src).pathname.slice(1);
    assert.ok(readFileSync(path).length > 0, `${path} is missing`);
  }
});

await check('the session ID carries which assistant connected, and nothing else', async () => {
  const { handler } = harness();
  const cases = [['claude-ai', 'claude'], ['openai-mcp', 'chatgpt'], ['Gemini CLI', 'gemini'], ['mcp-inspector', 'ai_assistant']];
  for (const [name, family] of cases) {
    const res = await call(handler, { body: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } }) });
    assert.equal(res.headers['mcp-session-id'], `${family}.11111111-2222-4333-8444-555555555555`);
    assert.equal(sessionFamily(res.headers['mcp-session-id']), family);
  }
  assert.equal(sessionFamily('stripe.11111111-2222-4333-8444-555555555555'), null, 'only the known families are read');
  assert.equal(sessionFamily('claude.not-a-uuid'), null);
  assert.equal(assistantFamily('Claude-User'), 'claude');
});

await check('notifications and client replies get 202 with no body', async () => {
  const { handler } = harness();
  for (const body of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, { jsonrpc: '2.0', id: 5, result: {} }]) {
    const res = await call(handler, { body });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body, undefined);
  }
});

await check('GET and DELETE answer 405: there is no event stream and no session to end', async () => {
  const { handler } = harness();
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const res = await call(handler, { method, headers: { accept: 'text/event-stream' } });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST, OPTIONS');
  }
});

await check('an unknown Origin is refused with 403; assistants, the site and local tools are allowed', async () => {
  const { handler } = harness();
  const evil = await call(handler, { body: rpc('ping'), headers: { origin: 'https://evil.example' } });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.body.error.code, -32000);
  for (const origin of ['https://claude.ai', 'https://chatgpt.com', 'https://www.assembleatease.com', 'http://localhost:6274']) {
    assert.ok(originAllowed(origin), origin);
    const ok = await call(handler, { body: rpc('ping'), headers: { origin } });
    assert.equal(ok.statusCode, 200, origin);
    assert.equal(ok.headers['access-control-allow-origin'], origin);
    assert.match(ok.headers['access-control-expose-headers'], /Mcp-Session-Id/);
  }
  const pre = await call(handler, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } });
  assert.equal(pre.statusCode, 204);
  assert.match(pre.headers['access-control-allow-headers'], /MCP-Protocol-Version/);
  assert.ok(originAllowed(undefined), 'server-to-server calls send no Origin');
  for (const origin of ['https://api.anthropic.com', 'https://connectors.claude.ai', 'https://platform.openai.com', 'https://web-sandbox.oaiusercontent.com']) assert.ok(originAllowed(origin), origin);
  for (const origin of ['http://localhost.evil.example', 'https://evilclaude.ai', 'https://claude.ai.evil.example', 'http://claude.ai', 'null', 'https://claude.ai/path', 'not a url']) assert.equal(originAllowed(origin), false, origin);
});

await check('an unsupported MCP-Protocol-Version header is a 400', async () => {
  const { handler } = harness();
  const res = await call(handler, { body: rpc('ping'), headers: { 'mcp-protocol-version': '2030-01-01' } });
  assert.equal(res.statusCode, 400);
  const ok = await call(handler, { body: rpc('ping'), headers: { 'mcp-protocol-version': '2025-06-18' } });
  assert.equal(ok.statusCode, 200);
});

await check('bad JSON, bad requests and unknown methods get JSON-RPC errors', async () => {
  const { handler } = harness();
  assert.equal((await call(handler, { body: '{not json' })).body.error.code, -32700);
  assert.equal((await call(handler, { body: '' })).statusCode, 400);
  // Vercel throws from the req.body getter on malformed JSON.
  const throwing = { method: 'POST', headers: {}, socket: {}, get body() { throw new SyntaxError('Unexpected token'); } };
  const thrownRes = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
  await handler(throwing, thrownRes);
  assert.equal(thrownRes.statusCode, 400);
  assert.equal(thrownRes.body.error.code, -32700);
  assert.equal((await call(handler, { body: JSON.stringify(rpc('ping')) })).body.result && true, true, 'a string body is parsed');
  assert.equal((await call(handler, { body: Buffer.from(JSON.stringify(rpc('ping'))) })).statusCode, 200, 'a raw body is parsed');
  assert.equal((await call(handler, { body: { id: 1, method: 'ping' } })).body.error.code, -32600);
  assert.equal((await call(handler, { body: { jsonrpc: '2.0', id: null, method: 'ping' } })).body.error.code, -32600);
  assert.equal((await call(handler, { body: rpc('tools/list', []) })).body.error.code, -32602);
  const unknown = await call(handler, { body: rpc('resources/list') });
  assert.equal(unknown.body.error.code, -32601);
  assert.equal(unknown.body.id, 1);
  const ping = await call(handler, { body: rpc('ping', undefined, 'abc') });
  assert.deepEqual(ping.body, { jsonrpc: '2.0', id: 'abc', result: {} });
});

await check('a batch gets one answer per request and none for notifications', async () => {
  const { handler } = harness();
  const res = await call(handler, { body: [rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', undefined, 2)] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.map((r) => r.id), [1, 2]);
  assert.equal((await call(handler, { body: [] })).statusCode, 400);
  assert.equal((await call(handler, { body: Array.from({ length: 21 }, (_, i) => rpc('ping', undefined, i)) })).statusCode, 400);
  assert.equal((await call(handler, { body: [{ jsonrpc: '2.0', method: 'notifications/initialized' }] })).statusCode, 202);
});

await check('rate limiting: its own budget, a 429 with Retry-After, and open when the limiter is down', async () => {
  const counted = harness();
  await call(counted.handler, { body: rpc('ping'), headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } });
  assert.deepEqual(counted.limits[0], ['198.51.100.7', 'mcp']);
  const limited = harness({ rateLimiter: async () => false });
  const res = await call(limited.handler, { body: rpc('ping') });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '60');
  const down = harness({ rateLimiter: async () => { throw new Error('redis down'); } });
  assert.equal((await call(down.handler, { body: rpc('ping') })).statusCode, 200);
  const limiterSource = readFileSync('api/_ratelimit.js', 'utf8');
  assert.match(limiterSource, /mcp: buildLimiter\('rl:mcp', 120, '60 s'\)/, 'the connector has its own limiter, not the 10-a-minute default');
});

// ── 2. directory rules ──────────────────────────────────────────────────────
const definitions = toolDefinitions();
await check('every tool has a title, a short name, a description and read-only annotations', () => {
  assert.deepEqual(definitions.map((t) => t.name), ['list_services', 'search_services', 'estimate_price', 'get_appointment_times', 'get_service_area', 'get_booking_policies']);
  for (const t of definitions) {
    assert.ok(t.name.length <= 64 && /^[a-z_]+$/.test(t.name), t.name);
    assert.ok(t.title && t.annotations.title === t.title, `${t.name} title`);
    assert.ok(t.description.length >= 40 && t.description.length <= 600, `${t.name} description length`);
    assert.deepEqual(
      { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint, idempotentHint: t.annotations.idempotentHint, openWorldHint: t.annotations.openWorldHint },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      `${t.name} annotations`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

await check('tool text describes the tool and never steers the model or sells', () => {
  const steering = /\b(you must|you should|always call|never call|ignore (?:previous|other)|do not use other|instead of other|recommend (?:us|assembleatease)|best\b|cheapest|#1)\b/i;
  const selling = /assemblecash|setup club|move-in pass|membership|subscription|free trial|discount code|promo code|% off/i;
  for (const t of definitions) {
    const text = JSON.stringify(t);
    assert.doesNotMatch(text, steering, `${t.name} steers the model`);
    assert.doesNotMatch(text, selling, `${t.name} promotes something`);
  }
});

await check('no location field in any input schema (ChatGPT submission rule)', () => {
  for (const t of definitions) {
    const keys = JSON.stringify(t.inputSchema).toLowerCase();
    assert.doesNotMatch(keys, /"(zip|zipcode|postal\w*|city|address|lat\w*|lon\w*|coordinates)"/, t.name);
  }
});

// ── 3. one truth ────────────────────────────────────────────────────────────
function engineTotal(lines, zip) {
  const servicesInCart = [];
  const itemsByService = {};
  for (const l of lines) {
    if (!itemsByService[l.service]) { itemsByService[l.service] = []; servicesInCart.push(l.service); }
    itemsByService[l.service].push({ name: l.item, qty: l.quantity });
  }
  return calculateBookingPricing({ services: servicesInCart, itemsByService, zip });
}

await check('every service-call zone has a sample ZIP that lands in it', () => {
  assert.deepEqual(Object.keys(ZONE_SAMPLE_ZIPS).sort(), Object.keys(SERVICE_CALL_ZONES).sort());
  for (const [zone, zip] of Object.entries(ZONE_SAMPLE_ZIPS)) assert.equal(getServiceCallZone(zip), zone, `${zip} -> ${zone}`);
});

await check('estimate_price totals equal the checkout engine for every zone, discount tiers included', () => {
  const pick = (service, n) => mainItems.filter((r) => r.service === service).slice(0, n);
  const carts = [
    [pick('Furniture Assembly', 1)[0]].map((r) => ({ service: r.service, item: r.item.name, quantity: 1 })),
    // 2 services, 3 items: the 10% tier
    [...pick('Furniture Assembly', 2), ...pick('Mounting & Hanging', 1)].map((r) => ({ service: r.service, item: r.item.name, quantity: 1 })),
    // 2 services, 6+ items: the 15% tier, with a quantity
    [...pick('Smart Home', 2), ...pick('Office Assembly', 1)].map((r, i) => ({ service: r.service, item: r.item.name, quantity: i === 0 ? 4 : 1 })),
  ];
  for (const cart of carts) {
    const result = callTool('estimate_price', { items: cart }, { catalog, now: NOW });
    assert.ok(!result.isError, result.content[0].text);
    const s = result.structuredContent;
    const engines = Object.values(ZONE_SAMPLE_ZIPS).map((zip) => engineTotal(cart, zip));
    const sameTotal = engines.every((e) => e.totalCents === engines[0].totalCents);
    if (sameTotal) {
      assert.equal(s.totalCents, engines[0].totalCents);
      assert.equal(s.total, `$${(engines[0].totalCents / 100).toFixed(2)}`);
    } else {
      assert.deepEqual(s.total.map((z) => z.total), engines.map((e) => `$${(e.totalCents / 100).toFixed(2)}`));
    }
    assert.equal(s.itemsSubtotal, `$${(engines[0].itemSubtotalCents / 100).toFixed(2)}`);
    assert.equal(s.salesTax.amount, `$${(engines[0].taxCents / 100).toFixed(2)}`);
    assert.equal(s.multiServiceDiscount ? s.multiServiceDiscount.percent : 0, engines[0].discountPct);
  }
});

await check('estimate_price merges repeated lines and fills a cart link that rebuilds the same cart', () => {
  const bed = mainItems.find((r) => r.item.name === 'Bed frame — queen') || mainItems[0];
  const tv = mainItems.find((r) => r.service === 'Mounting & Hanging');
  const result = callTool('estimate_price', { items: [
    { service: bed.service, item: bed.item.name, quantity: 1 },
    { service: tv.service, item: tv.item.name },
    { service: bed.service, item: bed.item.name.toUpperCase(), quantity: 2 },
  ] }, { catalog, source: 'claude' });
  const s = result.structuredContent;
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].quantity, 3);
  const url = new URL(s.bookingUrl);
  assert.equal(url.origin + url.pathname, `${SITE}/book`);
  const lines = url.searchParams.getAll('add').map((v) => v.split('|'));
  assert.deepEqual(lines, [[bed.service, bed.item.name, '3'], [tv.service, tv.item.name, '1']]);
  // What book.html does with each line (findCatalogItem by exact name).
  for (const [service, name] of lines) assert.ok(catalog.subcategories[service].some((g) => g.items.some((i) => i.name === name)), name);
  const book = readFileSync('book.html', 'utf8');
  assert.match(book, /var cartLines = params\.getAll\('add'\);/, 'book.html reads the cart link');
  assert.match(book, /split\('\|'\)/);
});

await check('estimate_price refuses what checkout refuses, with a reason the assistant can act on', () => {
  const addon = allItems.find((r) => r.item.addon && r.item.price > 0);
  const cases = [
    [{}, /items is required/],
    [{ items: [] }, /items is required/],
    [{ items: [{ service: 'Plumbing', item: 'Sink' }] }, /is not one of/],
    [{ items: [{ service: 'Furniture Assembly', item: 'bed queen' }] }, /Closest catalog items: .*Bed frame/],
    [{ items: [{ service: 'Furniture Assembly', item: mainItems[0].item.name, quantity: 0 }] }, /whole number from 1 to 99/],
    [{ items: [{ service: 'Furniture Assembly', item: mainItems[0].item.name, quantity: 2.5 }] }, /whole number/],
    [{ items: [{ service: addon.service, item: addon.item.name }] }, /Add-ons are booked together with a main item/],
    [{ items: [{ service: 'Furniture Assembly', item: mainItems[0].item.name, price: 1 }] }, /Unknown argument: price/],
    [{ items: Array.from({ length: 21 }, () => ({ service: 'Furniture Assembly', item: mainItems[0].item.name })) }, /up to 20/],
    [{ items: [{ service: 'Furniture Assembly', item: mainItems[0].item.name }], zip: '78701' }, /Unknown argument: zip/],
  ];
  for (const [args, message] of cases) {
    const result = callTool('estimate_price', args, { catalog });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, message);
  }
});

await check('a browser-supplied price can never change the estimate', () => {
  const r = mainItems[0];
  const result = callTool('estimate_price', { items: [{ service: r.service, item: r.item.name, quantity: 1 }] }, { catalog });
  assert.equal(result.structuredContent.items[0].unitPrice, `$${Number(r.item.price).toFixed(2)}`);
});

await check('list_services: every service, the catalog "From" price, and bundles priced by the engine', () => {
  const s = callTool('list_services', {}, { catalog }).structuredContent;
  assert.deepEqual(s.services.map((x) => x.service), services);
  for (const row of s.services) assert.equal(row.startingPrice, `$${trueFromPrice(catalog.subcategories[row.service])}`);
  const active = (catalog.bundles || []).filter((b) => b.active !== false);
  assert.equal(s.bundles.length, active.length);
  for (const b of s.bundles) {
    const source = active.find((x) => x.name === b.bundle);
    const engine = engineTotal(source.included.map((l) => ({ service: l.service, item: l.name, quantity: 1 })), null);
    assert.equal(b.itemsSubtotal, `$${(engine.itemSubtotalCents / 100).toFixed(2)}`, b.bundle);
    assert.equal(b.multiServiceDiscount ? b.multiServiceDiscount.amount : null, engine.discountCents > 0 ? `-$${(engine.discountCents / 100).toFixed(2)}` : null, `${b.bundle} discount`);
    assert.equal(new URL(b.bookingUrl).searchParams.get('bundle'), source.slug);
  }
  assert.ok(JSON.stringify(s).length < 20000, 'list_services stays a summary');
});

await check('search_services uses the booking page rule, then word by word for a sentence', () => {
  const search = catalogSearch();
  const dresser = callTool('search_services', { query: 'dresser' }, { catalog }).structuredContent;
  assert.equal(dresser.match, 'all_words');
  const expected = allItems.filter((r) => search.rank('dresser', search.searchText(r.service, r.group, r.item.name)) !== -1).map((r) => r.item.name);
  assert.deepEqual(dresser.results.map((r) => r.item).sort(), expected.slice(0, 15).sort());
  const sentence = callTool('search_services', { query: 'mount a 65 inch TV over the fireplace' }, { catalog }).structuredContent;
  assert.equal(sentence.match, 'some_words');
  assert.ok(sentence.results.some((r) => /TV 56"–65"/.test(r.item)), 'the 65-inch item is found');
  assert.ok(sentence.results.length <= 15);
  const none = callTool('search_services', { query: 'zzqx' }, { catalog }).structuredContent;
  assert.equal(none.match, 'none');
  assert.deepEqual(none.results, []);
  assert.equal(new URL(none.customQuote.bookingUrl).searchParams.get('service'), 'Other');
  const scoped = callTool('search_services', { query: 'chair', service: 'Office Assembly' }, { catalog }).structuredContent;
  assert.ok(scoped.results.length && scoped.results.every((r) => r.service === 'Office Assembly'));
  for (const [args, message] of [[{}, /query is required/], [{ query: '   ' }, /query is required/], [{ query: 'x'.repeat(121) }, /120 or fewer/], [{ query: 'tv', service: 'Plumbing' }, /is not one of/], [{ query: 'tv', zip: '78701' }, /Unknown argument/]]) {
    const result = callTool('search_services', args, { catalog });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
  }
});

await check('get_appointment_times gives the booking API\'s own window and open slots', () => {
  const window = bookingWindow(NOW);
  const today = callTool('get_appointment_times', {}, { catalog, now: NOW }).structuredContent;
  assert.equal(today.date, window.firstDate);
  assert.deepEqual(today.openArrivalWindows, openBookingSlots(window.firstDate, NOW));
  assert.deepEqual(today.allArrivalWindows, BOOKING_TIME_SLOTS);
  assert.equal(today.bookableUntil, window.lastDate);
  const later = callTool('get_appointment_times', { date: '2026-11-25' }, { catalog, now: NOW }).structuredContent;
  assert.deepEqual(later.openArrivalWindows, openBookingSlots('2026-11-25', NOW));
  for (const [args, message] of [[{ date: '2026-11-17' }, /in the past/], [{ date: '2027-03-01' }, /outside the booking window/], [{ date: '11/25/2026' }, /YYYY-MM-DD/], [{ date: '2026-02-30' }, /real date/]]) {
    const result = callTool('get_appointment_times', args, { catalog, now: NOW });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, message);
  }
});

await check('the same-day fee shows only when same-day service is switched on', () => {
  const before = process.env.SAME_DAY_ENABLED;
  try {
    delete process.env.SAME_DAY_ENABLED;
    assert.equal(callTool('get_appointment_times', {}, { catalog, now: NOW }).structuredContent.sameDayFee, undefined);
    process.env.SAME_DAY_ENABLED = 'true';
    assert.equal(callTool('get_appointment_times', {}, { catalog, now: NOW }).structuredContent.sameDayFee, '$69.00 before tax');
    assert.equal(callTool('get_appointment_times', { date: '2026-11-25' }, { catalog, now: NOW }).structuredContent.sameDayFee, undefined);
  } finally {
    if (before === undefined) delete process.env.SAME_DAY_ENABLED; else process.env.SAME_DAY_ENABLED = before;
  }
});

await check('get_service_area and get_booking_policies say what the source of truth and llms.txt say', () => {
  const facts = bookingFacts({ org: organization(), services: ['Furniture Assembly', 'Mounting & Hanging', 'Smart Home', 'Fitness Equipment', 'Outdoor & Playsets', 'Office Assembly'] });
  const llms = readFileSync('llms.txt', 'utf8');
  const area = callTool('get_service_area', {}, { catalog }).structuredContent;
  assert.deepEqual(area.automaticMatching.zipPrefixes, AUTOMATIC_DISPATCH_ZIP_PREFIXES);
  assert.deepEqual(area.automaticMatching.zipCodes, AUTOMATIC_DISPATCH_ZIPS);
  assert.ok(llms.includes(`- Where: ${facts.where}`) && area.summary === facts.where.replace(/^./, (c) => c.toUpperCase()));
  const policies = callTool('get_booking_policies', {}, { catalog }).structuredContent;
  for (const key of ['payment', 'cancellation', 'customQuotes', 'prices']) {
    assert.equal(policies[key].toLowerCase(), facts[key].toLowerCase(), key);
  }
  assert.ok(llms.includes(`- Cancellation: ${facts.cancellation}`), 'llms.txt carries the same cancellation sentence');
  assert.match(policies.cancellation, new RegExp(`${CANCELLATION_POLICY.lateFeePct}% fee`));
  const org = organization();
  assert.equal(policies.phone, org.telephone);
  assert.equal(policies.email, org.email);
});

// ── 4. no writes, no leaks ──────────────────────────────────────────────────
await check('the connector imports nothing that books, charges, emails, texts or dispatches', () => {
  const forbidden = /from '\.\/(?:_email|_sms|_push|_native-push|_customer-push|_stripe[\w-]*|_hubspot|_send-governor|_assemblecash|_gift-cards|_promotions)\.js'|from '\.\/booking\/(?!_booking-window|_booking-slots|_appt-date)[\w-]+\.js'|from 'stripe'/;
  for (const file of ['api/mcp.js', 'api/_mcp-tools.js', 'api/_public-facts.js']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, forbidden, `${file} imports a module that changes something`);
    assert.doesNotMatch(source, /\.from\(['"](?!operational_events)/, `${file} touches a table`);
  }
});

await check('usage rows hold the tool, the assistant and the outcome; never the arguments or the caller', async () => {
  const { handler, usage } = harness();
  await tool(handler, 'search_services', { query: 'secret sofa query' }, { 'mcp-session-id': 'chatgpt.11111111-2222-4333-8444-555555555555' });
  await tool(handler, 'estimate_price', { items: [] });
  assert.equal(usage.length, 2);
  assert.deepEqual(usage.map((u) => [u.event_type, u.stage, u.payload.assistant, u.payload.outcome, u.status_code]), [
    ['ai_assistant_tool_call', 'search_services', 'chatgpt', 'answered', 200],
    ['ai_assistant_tool_call', 'estimate_price', 'ai_assistant', 'invalid_arguments', 400],
  ]);
  const text = JSON.stringify(usage);
  assert.doesNotMatch(text, /secret|sofa|203\.0\.113\.9/);
  assert.equal(usage[0].route, '/api/mcp');
  assert.equal(usage[0].actor_role, 'anonymous');
  assert.equal(usage[0].mutation_result, 'none');
});

await check('a tool that breaks answers -32603 with a next step, and is counted', async () => {
  const { handler, usage } = harness({ tools: { hasTool: () => true, toolDefinitions, callTool: () => { throw new Error('catalog unreadable'); } } });
  const res = await call(handler, { body: rpc('tools/call', { name: 'list_services', arguments: {} }) });
  assert.equal(res.body.error.code, -32603);
  assert.match(res.body.error.message, /Try again/);
  assert.doesNotMatch(res.body.error.message, /catalog unreadable/);
  assert.equal(usage[0].payload.outcome, 'server_error');
});

await check('an unknown tool is a -32602 protocol error naming the real tools', async () => {
  const { handler, usage } = harness();
  const res = await call(handler, { body: rpc('tools/call', { name: 'create_booking', arguments: {} }) });
  assert.equal(res.body.error.code, -32602);
  assert.match(res.body.error.message, /estimate_price/);
  assert.equal(usage.length, 0);
});

await check('every word a customer reads passes the customer-language rules', async () => {
  const { handler } = harness();
  const outputs = [
    await tool(handler, 'list_services', {}),
    await tool(handler, 'search_services', { query: 'tv mount' }),
    await tool(handler, 'search_services', { query: 'zzqx' }),
    await tool(handler, 'estimate_price', { items: [{ service: mainItems[0].service, item: mainItems[0].item.name }] }),
    await tool(handler, 'estimate_price', { items: [{ service: 'Furniture Assembly', item: 'nope' }] }),
    await tool(handler, 'get_appointment_times', {}),
    await tool(handler, 'get_appointment_times', { date: '2020-01-01' }),
    await tool(handler, 'get_service_area', {}),
    await tool(handler, 'get_booking_policies', {}),
  ];
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  for (const out of outputs) walk(out.structuredContent || out.content[0].text);
  for (const t of definitions) strings.push(t.title, t.description);
  const prose = strings.filter((s) => !/^https?:\/\//.test(s)).join('\n');
  assert.deepEqual(findCustomerLanguageViolations(prose), []);
  assert.deepEqual(findJustifyingCopy(prose), []);
  assert.doesNotMatch(prose, /assemblecash|setup club|membership|needs_manual|pending|undefined|NaN/i);
});

await check('every booking link is on the site and tagged for the assistant that asked', async () => {
  for (const source of ASSISTANT_SOURCES) {
    const results = ['list_services', 'get_service_area', 'get_booking_policies', 'get_appointment_times']
      .map((name) => callTool(name, {}, { catalog, source, now: NOW }).structuredContent);
    results.push(callTool('estimate_price', { items: [{ service: mainItems[0].service, item: mainItems[0].item.name }] }, { catalog, source }).structuredContent);
    results.push(callTool('search_services', { query: 'desk' }, { catalog, source }).structuredContent);
    const links = [];
    const walk = (v, key) => { if (typeof v === 'string' && /url$/i.test(key || '') && /\/book/.test(v)) links.push(v); else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k)); };
    results.forEach((r) => walk(r));
    assert.ok(links.length >= 10, `${source}: ${links.length} links`);
    for (const link of links) {
      const url = new URL(link);
      assert.equal(url.origin, SITE);
      assert.equal(url.pathname, '/book');
      assert.equal(url.searchParams.get('utm_source'), source);
      assert.equal(url.searchParams.get('utm_medium'), 'ai_assistant');
      assert.match(url.searchParams.get('utm_campaign'), /^mcp_[a-z_]+$/);
      const attribution = cleanAcquisitionAttribution({ utmSource: url.searchParams.get('utm_source'), utmMedium: url.searchParams.get('utm_medium'), utmCampaign: url.searchParams.get('utm_campaign'), landingPath: url.pathname });
      assert.equal(attribution.channel, 'ai_assistant', link);
      assert.equal(attribution.utmCampaign, url.searchParams.get('utm_campaign'));
    }
  }
  assert.equal(new URL(bookingUrl({ source: 'stripe' })).searchParams.get('utm_source'), 'ai_assistant', 'an unknown source is never passed through');
});

await check('the owner acquisition report shows those bookings as "AI assistant"', () => {
  const booking = { booking_attribution: cleanAcquisitionAttribution({ utmSource: 'claude', utmMedium: 'ai_assistant', utmCampaign: 'mcp_estimate_price', landingPath: '/book' }) };
  assert.deepEqual(acquisitionForBooking(booking), { channel: 'ai_assistant', label: 'AI assistant', evidence: 'recorded' });
  const chatgptLink = { booking_attribution: cleanAcquisitionAttribution({ utmSource: 'chatgpt.com', landingPath: '/' }) };
  assert.equal(acquisitionForBooking(chatgptLink).channel, 'ai_assistant', 'ChatGPT tags its own links utm_source=chatgpt.com');
  const referred = { booking_attribution: cleanAcquisitionAttribution({ referrerHost: 'claude.ai', landingPath: '/' }) };
  assert.equal(acquisitionForBooking(referred).channel, 'ai_assistant');
  const google = { booking_attribution: cleanAcquisitionAttribution({ referrerHost: 'google.com', landingPath: '/' }) };
  assert.equal(acquisitionForBooking(google).channel, 'organic_search', 'search is unchanged');
  const browser = readFileSync('assets/js/attribution.js', 'utf8');
  for (const word of ["'claude'", "'chatgpt'", "'gemini'", "'ai_assistant'", "'chatgpt.com'", '|sora|mcp|']) assert.ok(browser.includes(word), `assets/js/attribution.js keeps ${word}`);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}.`);
