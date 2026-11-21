#!/usr/bin/env node
// Greater Houston dispatch health (owner, 2026-11-18). The owner sees
// assignment time, offer acceptance, unassigned bookings, cancellations and
// completed jobs, and recruitment triggers fire on operational strain. Counts
// are the lengths of the lists shipped with them; nothing here limits ads.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDispatchHealth, zipInMarket } from '../api/owner/_dispatch-health.js';
import { createDispatchHealthHandler, DISPATCH_HEALTH_EASER_SELECT } from '../api/owner/dispatch-health.js';
import { EASER_READINESS_FIELDS } from '../api/_easer-readiness-select.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS  ${name}`); }

const NOW = Date.parse('2026-11-18T18:00:00Z');
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();
const base = { is_test_booking: false, needs_manual_dispatch: false, dispatch_paused: false };

const strained = [
  { ...base, id: 'a', ref: 'AAE-A', service: 'Mounting & Hanging', service_city: 'Katy', service_zip: '77494', status: 'completed', date: '2026-11-10', time: '10:00 AM', created_at: iso(12000), confirmed_at: iso(11990), assembler_accepted_at: iso(11984), assembler_id: 'e1', completed_at: iso(8000) },
  { ...base, id: 'b', ref: 'AAE-B', service: 'Furniture Assembly', service_city: 'Spring', service_zip: '77389', status: 'confirmed', date: '2026-11-19', time: '9:00 AM', created_at: iso(300), confirmed_at: iso(290), assembler_id: null, needs_manual_dispatch: true },
  { ...base, id: 'c', ref: 'AAE-C', service: 'Outdoor & Playsets', service_city: 'Pearland', service_zip: '77584', status: 'cancelled', date: '2026-11-15', created_at: iso(5000), confirmed_at: iso(4990), assembler_id: null, cancel_reason: 'No Easer accepted before the appointment' },
  { ...base, id: 'd', ref: 'AAE-D', service: 'Furniture Assembly', service_city: 'Houston', service_zip: '77002', status: 'cancelled', date: '2026-11-16', created_at: iso(4000), confirmed_at: iso(3990), assembler_id: null, cancel_reason: 'Cancelled by customer (guest)' },
  { ...base, id: 'x', ref: 'AAE-AUSTIN', service: 'Furniture Assembly', service_city: 'Austin', service_zip: '78701', status: 'confirmed', date: '2026-11-19', created_at: iso(100), confirmed_at: iso(90), assembler_id: null },
  { ...base, id: 't', ref: 'AAE-TEST', service: 'Furniture Assembly', service_city: 'Houston', service_zip: '77002', status: 'confirmed', date: '2026-11-19', created_at: iso(100), confirmed_at: iso(90), assembler_id: null, is_test_booking: true },
];
const strainedOffers = [
  { booking_id: 'a', offer_status: 'accepted', attempt_number: 1 },
  { booking_id: 'a', offer_status: 'superseded', attempt_number: 1 },
  { booking_id: 'b', offer_status: 'expired', attempt_number: 1 },
  { booking_id: 'b', offer_status: 'expired', attempt_number: 2 },
  { booking_id: 'b', offer_status: 'declined', attempt_number: 3 },
  { booking_id: 'c', offer_status: 'expired', attempt_number: 1 },
];

await check('only Greater Houston (770-775) bookings count; Austin and test bookings are excluded', async () => {
  assert.equal(zipInMarket('77494', 'houston'), true);
  assert.equal(zipInMarket('78701', 'houston'), false);
  const r = buildDispatchHealth({ bookings: strained, offers: strainedOffers, easers: [{ id: 'e1', isReady: true }], now: NOW });
  assert.equal(r.summary.bookings, 4);
  assert.deepEqual(r.zipPrefixes, ['770', '771', '772', '773', '774', '775']);
});

await check('every count is the length of the list shipped with it', async () => {
  const r = buildDispatchHealth({ bookings: strained, offers: strainedOffers, easers: [{ id: 'e1', isReady: true }], now: NOW });
  assert.equal(r.summary.unassignedNow, r.unassigned.length);
  assert.equal(r.summary.manualFlaggedNow, r.manualFlagged.length);
  assert.equal(r.summary.cancelled, r.cancellations.length);
  assert.equal(r.summary.completed, r.completedJobs.length);
  assert.equal(r.summary.assigned, r.assignments.length);
  assert.deepEqual(r.unassigned.map(x => x.ref), ['AAE-B']);
  assert.deepEqual(r.completedJobs.map(x => x.ref), ['AAE-A']);
});

await check('assignment time and offer acceptance are measured from the rows', async () => {
  const r = buildDispatchHealth({ bookings: strained, offers: strainedOffers, easers: [{ id: 'e1', isReady: true }], now: NOW });
  assert.equal(r.summary.medianMinutesToAssign, 6);
  assert.equal(r.summary.offersAccepted, 1);
  assert.equal(r.summary.offersExpired, 3);
  assert.equal(r.summary.offersDeclined, 1);
  assert.equal(r.summary.acceptanceRate, 0.2, 'accepted out of answered or lapsed offers; superseded is excluded');
  assert.equal(r.summary.firstOfferAcceptanceRate, 1 / 3);
});

await check('strain fires recruitment triggers; a customer cancellation is not a supply problem', async () => {
  const r = buildDispatchHealth({ bookings: strained, offers: strainedOffers, easers: [{ id: 'e1', isReady: true }], now: NOW });
  const fired = Object.fromEntries(r.triggers.map(t => [t.key, t.fired]));
  assert.equal(fired.acceptance, true, '20% of 5 offers');
  assert.equal(fired.urgent_unassigned, true, 'AAE-B is unassigned the morning after');
  assert.equal(fired.no_easer_cancellation, true, 'AAE-C was cancelled before any Easer accepted');
  assert.equal(r.cancellations.find(x => x.ref === 'AAE-D').noEaserTookIt, false);
  assert.equal(r.recruitmentNeeded, true);
});

await check('a healthy market fires nothing', async () => {
  const healthy = [
    { ...base, id: 'h1', ref: 'AAE-H1', service_zip: '77002', status: 'completed', date: '2026-11-12', created_at: iso(9000), confirmed_at: iso(8990), assembler_accepted_at: iso(8985), assembler_id: 'e1' },
    { ...base, id: 'h2', ref: 'AAE-H2', service_zip: '77479', status: 'confirmed', date: '2026-11-25', created_at: iso(600), confirmed_at: iso(590), assembler_accepted_at: iso(580), assembler_id: 'e2' },
  ];
  const offers = [{ booking_id: 'h1', offer_status: 'accepted', attempt_number: 1 }, { booking_id: 'h2', offer_status: 'accepted', attempt_number: 1 }];
  const r = buildDispatchHealth({ bookings: healthy, offers, easers: [{ id: 'e1', isReady: true }, { id: 'e2', isReady: true }], now: NOW });
  assert.equal(r.recruitmentNeeded, false, JSON.stringify(r.triggers.filter(t => t.fired)));
});

await check('no ready Easer and a confirmed job means supply is the gap', async () => {
  const r = buildDispatchHealth({ bookings: strained, offers: [], easers: [], now: NOW });
  assert.equal(r.triggers.find(t => t.key === 'load').fired, true);
});

function fakeSupabase({ bookings = [], offers = [], profiles = [], failOn = null } = {}) {
  return {
    from(table) {
      const result = () => (failOn === table ? { data: null, error: { message: 'down' } }
        : { data: table === 'bookings' ? bookings : table === 'dispatch_offers' ? offers : profiles, error: null });
      const chain = { select() { return chain; }, or() { return chain; }, order() { return chain; }, limit() { return chain; }, in() { return chain; }, eq() { return chain; }, then(resolve) { return resolve(result()); } };
      return chain;
    },
  };
}
function fakeRes() {
  return { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

await check('the endpoint is owner-only, reads only, and names unknowns instead of showing zero', async () => {
  let res = fakeRes();
  await createDispatchHealthHandler({ verifyOwner: () => false, getSupabase: () => fakeSupabase() })({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await createDispatchHealthHandler({ verifyOwner: () => true, getSupabase: () => fakeSupabase() })({ method: 'GET', query: { market: 'mars' } }, res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await createDispatchHealthHandler({ verifyOwner: () => true, getSupabase: () => fakeSupabase({ failOn: 'dispatch_offers', bookings: strained }) })({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /unknown/);
  res = fakeRes();
  await createDispatchHealthHandler({
    verifyOwner: () => true, now: () => NOW,
    getSupabase: () => fakeSupabase({ bookings: strained, offers: strainedOffers, profiles: [{ id: 'e1', zip: '77002' }] }),
    getEaserReadiness: async () => ({ isReady: true }),
  })({ method: 'GET', query: { market: 'houston' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.market, 'houston');
  assert.equal(res.body.summary.readyEasers, 1);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

await check('readiness is judged from every readiness field', async () => {
  for (const field of EASER_READINESS_FIELDS) assert.ok(DISPATCH_HEALTH_EASER_SELECT.split(', ').includes(field), field);
});

await check('the dashboard renders the server report and never counts for itself', async () => {
  const html = readFileSync(new URL('../owner/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(html, /fetch\('\/api\/owner\/dispatch-health\?market=houston'/);
  const renderStart = html.indexOf('function renderDispatchHealth');
  const render = html.slice(renderStart, html.indexOf('\n  }\n', renderStart));
  assert.ok(render.length > 0);
  assert.doesNotMatch(render, /\.filter\(function\(\w+\) \{ return \w+\.status/, 'no client-side status filtering');
  assert.match(render, /s\.unassignedNow/);
  assert.match(html, /These numbers are unknown, not zero\./);
});

console.log(`\nDispatch health: ${passed} checks passed.`);
