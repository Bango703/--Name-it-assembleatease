#!/usr/bin/env node

/**
 * The platform must tell the owner what it already knows is broken.
 *
 * Three separate outages in one day were recorded with their exact cause and
 * surfaced nowhere:
 *
 *   notification_audit_failed  x5   "Could not find the 'provider_accepted_at'
 *                                    column of 'notification_log'"
 *                                   -> 12 hours of delivered mail logged as unsent
 *   financial_event_audit      failed  "no valid server-priced booking total"
 *                                   -> a refund that never reached the books
 *   assignment threw after committing -> Easer assigned, no email, owner shown 500
 *
 * Every one was found by hand, hours or months late. The data was always there.
 * Nothing read it back.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { collapseFailureAttempts, classifyFinancialIncidents } from '../api/owner/live-ops.js';

const api = await fs.readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8');
const ui = await fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

const collapsed = collapseFailureAttempts([
  { at: '2026-09-01T11:00:00.000Z', kind: 'transfer_attempt', bookingId: 'booking-1', detail: 'same lock' },
  { at: '2026-09-01T10:00:00.000Z', kind: 'transfer_attempt', bookingId: 'booking-1', detail: 'same lock' },
  { at: '2026-09-01T09:00:00.000Z', kind: 'transfer_attempt', bookingId: 'booking-2', detail: 'same lock' },
]);
assert.equal(collapsed.length, 2, 'retries for one booking must be one incident');
assert.equal(collapsed[0].attempts, 2, 'the owner must retain the retry count');
assert.equal(collapsed[0].at, '2026-09-01T11:00:00.000Z', 'incident recency must use the newest attempt');
assert.match(ui, /r\.attempts > 1[\s\S]*attempts/, 'the dashboard must label repeated attempts');

// ── The server reads its own failure records ────────────────────────────────
{
  assert.ok(/loadSelfDiagnosedFailures/.test(api), 'Live Ops must gather self-diagnosed failures');
  assert.ok(/from\('financial_event_audit'\)[\s\S]{0,200}\.eq\('status', 'failed'\)/.test(api),
    'failed financial events must be read back — a refund that never reconciled lives here');
  for (const kind of ['notification_audit_failed', 'dispatch_notification_failed', 'acceptance_notification_failed']) {
    assert.ok(api.includes(kind), `${kind} must be surfaced`);
  }
  assert.ok(/selfDiagnosed,/.test(api), 'the findings must ship in the Live Ops payload');
  assert.ok((api.match(/\.limit\(100\)/g) || []).length >= 2,
    'duplicate retries must not crowd distinct incidents out of the database read');
  assert.ok((api.match(/\.slice\(0, 20\)/g) || []).length >= 2,
    'the owner payload must be capped after retries are collapsed');
  console.log('PASS the server reads back the failures it already recorded');
}

// ── Diagnostics can never break the dashboard ───────────────────────────────
{
  const fn = api.slice(api.indexOf('async function loadSelfDiagnosedFailures'));
  const body = fn.slice(0, fn.indexOf('\nexport default'));
  assert.equal((body.match(/catch \(err\)/g) || []).length, 2,
    'both lookups must be individually caught — one failing must not lose the other');
  assert.ok(!/throw /.test(body), 'the gatherer must never throw');
  assert.ok(/try \{ renderSelfDiagnosed\(d\); \} catch/.test(ui),
    'the renderer must be wrapped — a diagnostics panel must never blank Live Ops');
  console.log('PASS a failing diagnostics lookup can never take down the dashboard');
}

// ── It shows the real cause, and stays quiet when healthy ───────────────────
{
  assert.ok(/r\.error \|\| 'no reason recorded'/.test(api),
    "the server's own error text must be passed through, not replaced with something generic");
  assert.ok(/emailLogError \|\| r\.metadata\?\.pushLogError/.test(api),
    'the captured cause must be surfaced — that string is what made the outage findable');

  const fn = ui.slice(ui.indexOf('function renderSelfDiagnosed('));
  const body = fn.slice(0, fn.indexOf('\n  function arrivalBadge('));
  assert.ok(/if \(!sd \|\| \(!sd\.total && !\(sd\.sourceErrors \|\| \[\]\)\.length\)\)[\s\S]{0,80}display = 'none'/.test(body),
    'a healthy platform must show nothing — a permanent banner is ignored within a week');
  assert.ok(/no reason recorded/.test(body), 'a missing cause must say so rather than invent one');
  console.log('PASS it shows the real cause, and disappears entirely when nothing is wrong');
}

// ── A resolved incident must not read as a live fire ───────────────
// Eight notification_audit_failed rows from 2026-08-27 sat in a uniformly red
// panel labelled only 'last 72 hours'. The cause (migration 068's missing
// schema-cache reload) was fixed and nothing had failed for 53 hours, but the
// owner had no way to tell that from the panel and read it as current.
{
  const fn = ui.slice(ui.indexOf('function renderSelfDiagnosed('));
  const body = fn.slice(0, fn.indexOf('\n  function arrivalBadge('));

  // Evaluate the REAL recency block, not a paraphrase of it.
  const start = body.indexOf('var newestMs');
  const tail = "last 72 hours');";
  const end = body.indexOf(tail, body.indexOf("' ago ", start)) + tail.length;
  assert.ok(start > 0 && end > start, 'the recency block must exist in the renderer');
  const snippet = body.slice(start, end);
  const evaluate = new Function('rows', 'var sd = {}; ' + snippet + '; return { recency, settled, historyOnly };');

  const hoursAgo = h => [{ at: new Date(Date.now() - h * 3600000).toISOString() }];

  const stale = evaluate(hoursAgo(53));
  assert.equal(stale.settled, true, 'recency reports the quiet period');
  assert.equal(stale.historyOnly, false, 'time passing must not resolve a financial incident');
  assert.match(stale.recency, /nothing new in 5[23]h/,
    'a settled panel must say how long it has been quiet');

  const live = evaluate(hoursAgo(0.5));
  assert.equal(live.settled, false, 'a failure 30 minutes old is still active');
  assert.match(live.recency, /newest \d+m ago/,
    'a fresh failure must show minutes, not be rounded away to 0h');

  const edge = evaluate(hoursAgo(6));
  assert.equal(edge.settled, true, 'the six-hour boundary settles');

  // Tone must follow the same fact, or the colour contradicts the words.
  assert.ok(/historyOnly \? 'var\(--border\)' : '#fed7aa'/.test(body),
    'verified recovery must use the neutral history presentation');
  assert.ok(/border:1px solid ' \+ edge \+ '/.test(body),
    'the panel border must follow the computed tone rather than a fixed red');
  console.log('PASS a settled incident is toned and labelled differently from a live one');
}

// A real failed attempt followed by a matching, verified completion is history.
// Other money events and unverified outcomes must remain actionable.
const incident = { at: '2026-09-26T16:27:29Z', kind: 'capture_attempt', bookingId: 'booking-1', paymentIntentId: 'pi_same', detail: 'Stripe captured payment does not match this booking.', attempts: 1 };
const completed = { id: 'booking-1', ref: 'AAE-TEST', status: 'completed', payment_status: 'captured', total_price: 42651, amount_charged: 42651, stripe_payment_intent_id: 'pi_same', payment_captured_at: '2026-09-26T16:36:40Z', completed_at: '2026-09-26T16:36:40Z' };
const recovered = classifyFinancialIncidents([incident], [completed])[0];
assert.equal(recovered.state, 'recovered');
assert.match(recovered.resolution, /\$426\.51/);
assert.equal(recovered.detail, incident.detail, 'the original failure remains auditable');
for (const overrides of [
  { id: 'other-booking' }, { status: 'in_progress' }, { payment_status: 'authorized' },
  { amount_charged: 1 }, { total_price: 0 }, { stripe_payment_intent_id: 'pi_other' },
  { payment_captured_at: incident.at }, { completed_at: null },
  { financial_reconciliation_required_at: '2026-09-27T00:00:00Z' },
  { cancellation_reconciliation_required_at: '2026-09-27T00:00:00Z' },
  { financial_operation_type: 'refund' },
  { financial_operation_key: 'orphan-lock' },
  { financial_operation_started_at: '2026-09-27T00:00:00Z' },
]) {
  assert.equal(classifyFinancialIncidents([incident], [{ ...completed, ...overrides }])[0].state, 'needs_review', JSON.stringify(overrides));
}
assert.equal(classifyFinancialIncidents([incident], [])[0].state, 'needs_review');
assert.equal(classifyFinancialIncidents([{ ...incident, kind: 'transfer_attempt' }], [completed])[0].state, 'needs_review');
assert.equal(classifyFinancialIncidents([{ ...incident, paymentIntentId: null }], [completed])[0].state, 'needs_review');

// Execute the shipped renderer, including its booking drilldown event handler.
const renderStart = ui.indexOf('  function renderSelfDiagnosed(d)');
const renderEnd = ui.indexOf('  // Off-platform leakage watch.', renderStart);
assert.ok(renderStart > 0 && renderEnd > renderStart);
let opened = null;
let click = null;
const button = { dataset: { incidentBooking: 'booking-1' }, addEventListener(type, fn) { if (type === 'click') click = fn; } };
const element = { style: {}, innerHTML: '', querySelectorAll() { return this.innerHTML.includes('data-incident-booking') ? [button] : []; } };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const render = new Function('document', 'esc', 'window', ui.slice(renderStart, renderEnd) + ';return renderSelfDiagnosed;')(
  { getElementById: () => element }, escapeHtml, { openOwnerBookingRecord(...args) { opened = args; } },
);
render({ selfDiagnosed: { total: 1, financial: [recovered] } });
assert.match(element.innerHTML, /^<details /, 'recovered incidents are collapsed history');
assert.match(element.innerHTML, /Recovered incidents \(1\)/);
assert.match(element.innerHTML, /Payment collected: \$426\.51/);
assert.match(element.innerHTML, /Earlier attempt:/);
assert.doesNotMatch(element.innerHTML, /incident needs review/);
assert.equal(typeof click, 'function');
click();
assert.deepEqual(opened, ['booking-1', null, true], 'incident drilldown explicitly refreshes even a cached booking');
render({ selfDiagnosed: { total: 1, financial: classifyFinancialIncidents([incident], []) } });
assert.match(element.innerHTML, /1 incident needs review/);
assert.doesNotMatch(element.innerHTML, /^<details /);
render({ selfDiagnosed: { total: 10, financial: [
  ...Array.from({ length: 9 }, (_, i) => ({ ...recovered, bookingId: 'recovered-' + i, at: '2026-09-27T00:00:00Z' })),
  { ...incident, detail: 'Unresolved older payment', state: 'needs_review' },
] } });
assert.match(element.innerHTML, /Unresolved older payment/, 'recent recovered history cannot hide an unresolved action');
assert.match(element.innerHTML, /1 incident needs review/);
render({ selfDiagnosed: { total: 0, sourceErrors: ['Current payment outcomes could not be verified.'] } });
assert.equal(element.style.display, '');
assert.match(element.innerHTML, /could not be verified/);
render({ selfDiagnosed: { total: 0 } });
assert.equal(element.style.display, 'none');
assert.equal(element.innerHTML, '');
console.log('PASS verified recovery, conservative unknown/mismatched states, history rendering and booking drilldown');

// Run the real drilldown helpers against a stale cached booking. A fresh read
// must finish before detail rendering, and a failed read must not show that
// stale payment state or trigger a payout action.
const payoutStart = ui.indexOf('  window.openPayoutBooking = async function(');
const payoutEnd = ui.indexOf('\n  };', payoutStart) + '\n  };'.length;
const bookingStart = ui.indexOf('  window.openOwnerBookingRecord = async function(');
const bookingEnd = ui.indexOf('\n  };', bookingStart) + '\n  };'.length;
assert.ok(payoutStart > 0 && payoutEnd > payoutStart && bookingStart > 0 && bookingEnd > bookingStart);
function drilldownFixture(outcome = { bookings: [completed] }) {
  const requests = [], selected = [], errors = [], detailClasses = new Set(['open']);
  let payoutClicks = 0, ledgerReads = 0;
  const context = {
    window: {}, allBookings: [{ ...completed, status: 'in_progress', payment_status: 'authorized', amount_charged: 0 }],
    currentView: 'liveops', currentStatus: 'confirmed', searchQuery: 'old filter',
    stopMarketDemand() {}, stopLiveOps() {}, hideAllViews() {},
    $bookingsView: { style: {} }, $topbarTitle: {}, $detailPh: { style: { display: 'none' } },
    $detail: { classList: { remove(name) { detailClasses.delete(name); } } },
    document: { getElementById() { return {}; }, querySelectorAll() { return []; }, querySelector() { return { click() { context.currentView = 'bookings'; } }; } },
    async apiGet(path) { requests.push(path); if (outcome instanceof Error) throw outcome; return outcome; },
    renderList() {}, async selectBooking(id) { selected.push({ ...context.allBookings.find(row => row.id === id) }); detailClasses.add('open'); },
    toast(message) { errors.push(message); }, switchDetailTab() {},
    async loadPayoutLedger() { ledgerReads++; }, payoutTruthAvailable: true,
    payoutJobsByBookingId: new Map([['booking-1', { disposition: 'pending' }]]),
    $detailAct: { querySelectorAll() { return [{ dataset: { id: 'booking-1' }, click() { payoutClicks++; } }]; } },
  };
  vm.runInNewContext(ui.slice(payoutStart, payoutEnd) + '\n' + ui.slice(bookingStart, bookingEnd), context);
  return { context, requests, selected, errors, detailClasses, get payoutClicks() { return payoutClicks; }, get ledgerReads() { return ledgerReads; } };
}
{
  const f = drilldownFixture();
  assert.equal(await f.context.window.openOwnerBookingRecord('booking-1', null, true), true);
  assert.deepEqual(f.requests, ['/list?limit=1&bookingId=booking-1']);
  assert.equal(f.context.allBookings.length, 1, 'refresh replaces rather than duplicates the cached record');
  assert.equal(f.selected[0].status, 'completed'); assert.equal(f.selected[0].payment_status, 'captured');
  assert.equal(f.selected[0].amount_charged, 42651);
  assert.equal(f.payoutClicks, 0); assert.equal(f.ledgerReads, 0);
}
for (const failure of [new Error('Current booking could not be loaded'), { bookings: [] }]) {
  const f = drilldownFixture(failure);
  assert.equal(await f.context.window.openOwnerBookingRecord('booking-1', null, true), false);
  assert.equal(f.requests.length, 1); assert.equal(f.selected.length, 0);
  assert.equal(f.detailClasses.has('open'), false, 'previous stale detail is hidden when a current read fails');
  assert.equal(f.context.$detailPh.style.display, '');
  assert.equal(f.errors.length, 1); assert.equal(f.payoutClicks, 0); assert.equal(f.ledgerReads, 0);
}
{
  const f = drilldownFixture();
  assert.equal(await f.context.window.openPayoutBooking('booking-1', 'AAE-TEST', 'record'), true);
  assert.equal(f.ledgerReads, 1); assert.equal(f.requests.length, 1); assert.equal(f.payoutClicks, 1);
  assert.equal(f.selected[0].payment_status, 'captured', 'existing payout-record intent still validates and refreshes');
}
{
  const f = drilldownFixture();
  assert.equal(await f.context.window.openOwnerBookingRecord('booking-1'), true);
  assert.equal(f.requests.length, 0, 'other existing drilldowns preserve their previous read behavior');
  assert.equal(f.payoutClicks, 0);
}
console.log('PASS current incident drilldown replaces cached truth; failed refresh hides stale detail; payout intent preserved');

const unsafe = '\"><img src=x onerror=alert(1)>';
render({ selfDiagnosed: { total: 1, financial: [{ ...recovered, detail: unsafe, resolution: unsafe, bookingId: unsafe, bookingRef: unsafe }], sourceErrors: [unsafe] } });
assert.doesNotMatch(element.innerHTML, /<img|data-incident-booking="">/);
assert.match(element.innerHTML, /&quot;&gt;&lt;img/);

// Database errors are normally returned, but transport failures can throw.
// Exercise both forms on each read boundary of the production gatherer.
const gatherStart = api.indexOf('async function loadSelfDiagnosedFailures(');
const gatherEnd = api.indexOf('// Completion validates Stripe', gatherStart);
const gather = new Function('classifyFinancialIncidents', 'collapseFailureAttempts', 'console', api.slice(gatherStart, gatherEnd) + ';return loadSelfDiagnosedFailures;')(
  classifyFinancialIncidents, collapseFailureAttempts, { error() {} },
);
function incidentDatabase(failedTable, throws) {
  const records = {
    financial_event_audit: [{ created_at: incident.at, event_type: incident.kind, error: incident.detail, booking_id: incident.bookingId, payment_intent_id: incident.paymentIntentId }],
    bookings: [completed], activity_logs: [{ created_at: incident.at, event_type: 'dispatch_notification_failed', description: 'Original notification failure', metadata: {}, booking_id: incident.bookingId }],
  };
  return { from(table) {
    const query = {
      select() { return query; }, eq() { return query; }, gte() { return query; }, order() { return query; }, limit() { return query; }, in() { return query; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (table === failedTable) {
          if (throws) throw new Error('Source unavailable');
          return { data: null, error: { message: 'Source unavailable' } };
        }
        return { data: records[table], error: null };
      }).then(resolve, reject); },
    };
    return query;
  } };
}
for (const throws of [false, true]) {
  for (const table of ['financial_event_audit', 'bookings', 'activity_logs']) {
    const result = await gather(incidentDatabase(table, throws), '2026-09-25T00:00:00Z');
    assert.ok(result.sourceErrors.length, `${table} failure must remain visible`);
    if (table === 'financial_event_audit') assert.equal(result.financial.length, 0);
    else if (table === 'bookings') {
      assert.notEqual(result.financial[0].state, 'recovered');
      assert.equal(result.financial[0].detail, incident.detail);
    } else assert.equal(result.financial[0].state, 'recovered');
    assert.equal(result.notification.length, table === 'activity_logs' ? 0 : 1, 'independent source survives failure');
  }
}
console.log('PASS returned and thrown read failures remain visible without hiding independent incidents or inventing recovery');
console.log('\nSelf-diagnosed failure tests passed.');
