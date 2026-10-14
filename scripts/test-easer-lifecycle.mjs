#!/usr/bin/env node
// The rest of the Easer job lifecycle (owner audit, 2026-10-12). The owner asked
// for every missing flow to be put in place and verified:
//   1 help from inside a job          7 propose a new time
//   2 customer not home + no-show      8 running late
//   3 tips visible                     9 the App Review account can release its test job
//   4 reliability standing in the app 10 services and hours, read by dispatch
//   5 extra work on site               11 private customer rating and flags
//   6 the time a reschedule moved from
// Real handlers run against an in-memory database; no network, no live data.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeWorkPreferences, easerTakesBooking, slotStartMinutes, bookingServiceNames } from '../api/_easer-work-preferences.js';
import { customerUnavailableState, CUSTOMER_WAIT_MINUTES, EASER_SUPPORT_TYPES } from '../api/booking/_easer-support.js';
import { summarizeTips, tipNetCents } from '../api/assembler/_easer-tips.js';
import { matchingProposal } from '../api/booking/_time-proposals.js';
import * as pricing from '../api/_pricing.js';
import * as changeOrders from '../api/booking/_change-orders.js';
import { BOOKING_STATUS } from '../api/_source-of-truth.js';

const read = (f) => readFileSync(f, 'utf8');
const SERVICES = ['Furniture Assembly', 'Mounting & Hanging', 'Smart Home'];

// ── 10. Services and hours ───────────────────────────────────────────────────
{
  const ok = normalizeWorkPreferences({ services: ['Smart Home'], availability: { mon: [{ start: '08:00', end: '12:00' }] } }, SERVICES);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.services, ['Smart Home']);
  assert.deepEqual(ok.value.availability.tue, [], 'a day not set is a day off');
  assert.equal(normalizeWorkPreferences({ services: SERVICES }, SERVICES).value.services, null, 'every service is stored as all');
  assert.equal(normalizeWorkPreferences({ services: ['Junk Removal'] }, SERVICES).ok, false, 'only catalog services');
  assert.equal(normalizeWorkPreferences({ services: [] }, SERVICES).ok, false);
  assert.equal(normalizeWorkPreferences({ availability: { mon: [{ start: '12:00', end: '09:00' }] } }, SERVICES).ok, false, 'a range ends after it starts');
  assert.equal(normalizeWorkPreferences({ availability: { mon: [] } }, SERVICES).ok, false, 'at least one day');

  assert.equal(slotStartMinutes('10:00 AM - 12:00 PM'), 600);
  assert.equal(slotStartMinutes('12:00 PM - 2:00 PM'), 720);
  assert.deepEqual(bookingServiceNames({ service: 'Mounting & Hanging' }, SERVICES), ['Mounting & Hanging']);

  const thursdayTen = { service: 'Furniture Assembly', date: '2026-10-15', time: '10:00 AM - 12:00 PM' };
  assert.equal(easerTakesBooking(null, thursdayTen, SERVICES).ok, true, 'no preferences: every job');
  assert.equal(easerTakesBooking({ work_services: ['Smart Home'] }, thursdayTen, SERVICES).reason, 'service');
  assert.equal(easerTakesBooking({ work_services: ['Furniture Assembly'] }, thursdayTen, SERVICES).ok, true);
  assert.equal(easerTakesBooking({ weekly_availability: { thu: [{ start: '08:00', end: '12:00' }] } }, thursdayTen, SERVICES).ok, true);
  assert.equal(easerTakesBooking({ weekly_availability: { thu: [{ start: '13:00', end: '18:00' }] } }, thursdayTen, SERVICES).reason, 'hours');
  assert.equal(easerTakesBooking({ weekly_availability: { fri: [{ start: '08:00', end: '18:00' }] } }, thursdayTen, SERVICES).reason, 'hours', 'a day off is off');
  assert.equal(easerTakesBooking({ work_services: ['Smart Home'] }, { service: 'Something New' }, SERVICES).ok, true, 'an unknown service fails open');
  assert.equal(easerTakesBooking({ work_services: ['Smart Home'] }, thursdayTen, []).ok, true, 'no catalog fails open');

  const dispatch = read('api/booking/_dispatch-internal.js');
  assert.match(dispatch, /const workPreferences = await loadWorkPreferences\(sb, eligible\.map\(e => e\.id\)\);\s*if \(workPreferences\.size\) \{\s*eligible = eligible\.filter\(e => easerTakesBooking\(workPreferences\.get\(e\.id\), booking\)\.ok\);/, 'dispatch reads the preferences and fails open');
  const prefsModule = read('api/_easer-work-preferences.js');
  assert.match(prefsModule, /if \(error\) return new Map\(\);/, 'a database without the columns dispatches as before');
}

// ── 2. Customer not home ─────────────────────────────────────────────────────
{
  const t0 = Date.parse('2026-10-15T15:10:00Z');
  const reported = [{ event_type: 'customer_unavailable_reported', created_at: new Date(t0).toISOString() }];
  assert.equal(customerUnavailableState([], t0), null);
  const waiting = customerUnavailableState(reported, t0 + 5 * 60000);
  assert.equal(waiting.canReportNoShow, false, 'the customer gets the full wait');
  assert.equal(Date.parse(waiting.waitUntil) - t0, CUSTOMER_WAIT_MINUTES * 60000);
  assert.equal(customerUnavailableState(reported, t0 + CUSTOMER_WAIT_MINUTES * 60000).canReportNoShow, true);
  const reportedNoShow = customerUnavailableState([{ event_type: 'customer_no_show_reported', created_at: new Date(t0 + 20 * 60000).toISOString() }, ...reported], t0 + 30 * 60000);
  assert.equal(reportedNoShow.canReportNoShow, false, 'reported once');
  assert.ok(reportedNoShow.noShowReportedAt);
  assert.ok(EASER_SUPPORT_TYPES.customer_no_show && EASER_SUPPORT_TYPES.customer_unavailable, 'both are owner cases');
  const message = read('api/booking/message.js');
  assert.match(message, /import \{ EASER_SUPPORT_TYPES \} from '\.\/_easer-support\.js';/, 'one list of help types');
  assert.doesNotMatch(message, /const EASER_SUPPORT_TYPES = /);
  const endpoint = read('api/booking/customer-unavailable.js');
  assert.doesNotMatch(endpoint, /stripe|capture|refund|cancellation_fee/i, 'no money moves here; the owner confirms through cancel');
}

// ── 3. Tips ──────────────────────────────────────────────────────────────────
{
  assert.equal(tipNetCents({ amount_cents: 2000, stripe_fee_cents: 88 }), 1912);
  assert.equal(tipNetCents({ amount_cents: 2000, stripe_fee_cents: 88, easer_net_cents: 1912, refunded_cents: 500 }), 1412);
  assert.equal(tipNetCents({ amount_cents: 2000 }), 2000, 'fee not known yet: the amount');
  const summary = summarizeTips([
    { amount_cents: 2000, stripe_fee_cents: 88, status: 'succeeded' },
    { amount_cents: 1000, stripe_fee_cents: null, status: 'succeeded' },
    { amount_cents: 500, status: 'failed' },
  ]);
  assert.equal(summary.count, 2, 'a failed charge is not a tip');
  assert.equal(summary.amountCents, 3000);
  assert.equal(summary.feePending, true);
  assert.match(read('api/assembler/earnings.js'), /tips = await loadEaserTips\(sb, authenticated\.user\.id\);[\s\S]{0,200}earnings,\s*summary: summarizeEaserEarnings\(earnings\),\s*tips,/, 'earnings carry tips, and a tip failure never hides earnings');
  assert.doesNotMatch(read('api/assembler/_easer-tips.js'), /payout_ledger|computeBookingSplit/, 'a tip is never a platform payout');
}

// ── In-memory database for the handlers ──────────────────────────────────────
function memoryDb(seed) {
  const rows = structuredClone(seed);
  let nextId = 1;
  const db = {
    rows,
    from(table) {
      rows[table] ||= [];
      let op = 'select', payload = null, conflict = null, limit = Infinity, order = null, single = false;
      const preds = [];
      const run = () => {
        let matches = rows[table].filter(r => preds.every(p => p(r)));
        if (op === 'insert') {
          const list = (Array.isArray(payload) ? payload : [payload]).map(p => ({ id: `${table}-${nextId++}`, created_at: new Date().toISOString(), ...p }));
          rows[table].push(...list);
          return { data: Array.isArray(payload) ? list : list[0], error: null };
        }
        if (op === 'upsert') {
          const keys = String(conflict).split(',');
          const existing = rows[table].find(r => keys.every(k => r[k] === payload[k]));
          if (existing) { Object.assign(existing, payload); return { data: existing, error: null }; }
          const row = { id: `${table}-${nextId++}`, created_at: new Date().toISOString(), ...payload };
          rows[table].push(row);
          return { data: row, error: null };
        }
        if (op === 'update') { matches.forEach(r => Object.assign(r, payload)); return { data: matches, error: null }; }
        if (op === 'delete') { rows[table] = rows[table].filter(r => !matches.includes(r)); return { data: null, error: null }; }
        if (order) matches = [...matches].sort((a, b) => (a[order.col] < b[order.col] ? -1 : 1) * (order.asc ? 1 : -1));
        return { data: matches.slice(0, limit), error: null };
      };
      const q = {
        select() { return q; },
        eq(f, v) { preds.push(r => r[f] === v); return q; },
        neq(f, v) { preds.push(r => r[f] !== v); return q; },
        in(f, vs) { preds.push(r => vs.includes(r[f])); return q; },
        is(f, v) { preds.push(r => (r[f] ?? null) === v); return q; },
        order(col, opts = {}) { order = { col, asc: opts.ascending !== false }; return q; },
        limit(n) { limit = n; return q; },
        insert(p) { op = 'insert'; payload = p; return q; },
        upsert(p, opts) { op = 'upsert'; payload = p; conflict = opts?.onConflict; return q; },
        update(p) { op = 'update'; payload = p; return q; },
        delete() { op = 'delete'; return q; },
        async maybeSingle() { const r = run(); const d = Array.isArray(r.data) ? r.data[0] || null : r.data; return { data: d, error: r.error }; },
        async single() { return q.maybeSingle(); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return q;
    },
  };
  return db;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function loadHandler(path, deps) {
  const source = read(path)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/export default async function/, 'async function')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
    .replace(/export async function /g, 'async function ');
  return new AsyncFunction(...Object.keys(deps), `${source}\nreturn { handler };`)(...Object.values(deps));
}
async function call(handler, { method = 'POST', body = {}, query = {} } = {}) {
  const res = { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method, body, query, headers: { authorization: 'Bearer t', 'x-forwarded-for': '1.1.1.1' } }, res);
  return res;
}

const EASER = 'easer-1';
const sent = { emails: [], texts: [], cases: [] };
const commonDeps = (db) => ({
  getSupabase: () => db,
  sendEmail: async (m) => { sent.emails.push(m); return { ok: true }; },
  ownerEmail: () => 'owner@example.com',
  esc: (s) => String(s ?? ''),
  sendSms: async (m) => { sent.texts.push(m); return { ok: true }; },
  // The customer app's notification (api/_customer-push.js); it never throws in production.
  notifyCustomerApp: async (_sb, bookingId, event) => { (sent.appPushes ||= []).push({ bookingId, event }); return { sent: 0 }; },
  guestManageUrl: (b) => `https://example.com/track?ref=${b.ref}`,
  BOOKING_STATUS,
  requireAssignedWorkEaser: async () => ({ ok: true, user: { id: EASER } }),
  respondWithEaserAccessError: (res, a) => res.status(a.status || 403).json({ error: 'denied' }),
  createOperationCase: async (_sb, input) => { sent.cases.push(input); return { id: 'case-1', case_ref: 'CASE-1' }; },
  OPERATION_CASE_SOURCES: { EASER_REPORT: 'easer_report' },
  OPERATION_CASE_TYPES: { SAFETY: 'safety', SUPPORT: 'support' },
  OPERATION_CASE_SEVERITIES: { HIGH: 'high', CRITICAL: 'critical', NORMAL: 'normal' },
  logActivity: async (sb, e) => { await sb.from('activity_logs').insert({ booking_id: e.bookingId, event_type: e.eventType, description: e.description, metadata: e.metadata || null }); return { ok: true }; },
});

// ── 2. Customer not home, end to end ─────────────────────────────────────────
{
  const db = memoryDb({ bookings: [{ id: 'b1', ref: 'AAE-1', service: 'Furniture Assembly', status: 'arrived', assembler_id: EASER, assembler_name: 'Pat Doe', assembler_accepted_at: '2026-10-14T00:00:00Z', customer_email: 'c@example.com', customer_phone: '+15125550100', sms_consent_at: '2026-10-01T00:00:00Z' }], activity_logs: [] });
  const { handler } = await loadHandler('api/booking/customer-unavailable.js', { ...commonDeps(db), EASER_SUPPORT_TYPES, CUSTOMER_WAIT_MINUTES, customerUnavailableState });
  sent.texts.length = 0; sent.cases.length = 0;
  const early = await call(handler, { body: { bookingId: 'b1', action: 'no_show' } });
  assert.equal(early.statusCode, 409, 'no no-show before the customer is told');
  const start = await call(handler, { body: { bookingId: 'b1', action: 'start' } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.body));
  assert.equal(start.body.canReportNoShow, false);
  assert.equal(sent.texts.length, 1, 'the customer is texted');
  assert.match(sent.texts[0].body, /can't reach you/);
  assert.equal(sent.cases[0].metadata.supportType, 'customer_unavailable', 'the owner gets a case');
  const again = await call(handler, { body: { bookingId: 'b1', action: 'start' } });
  assert.equal(again.body.waitUntil, start.body.waitUntil, 'asking twice keeps the first clock');
  assert.equal(sent.texts.length, 1, 'and does not text twice');
  const tooSoon = await call(handler, { body: { bookingId: 'b1', action: 'no_show' } });
  assert.equal(tooSoon.statusCode, 409);
  assert.match(tooSoon.body.error, /Wait \d+ more minute/);
  db.rows.activity_logs[0].created_at = new Date(Date.now() - (CUSTOMER_WAIT_MINUTES + 1) * 60000).toISOString();
  const noShow = await call(handler, { body: { bookingId: 'b1', action: 'no_show' } });
  assert.equal(noShow.statusCode, 200, JSON.stringify(noShow.body));
  assert.ok(noShow.body.noShowReportedAt);
  assert.equal(sent.cases.at(-1).metadata.supportType, 'customer_no_show');
  assert.equal(db.rows.bookings[0].status, 'arrived', 'the booking is not cancelled here; the owner confirms');
  db.rows.bookings[0].status = 'en_route';
  db.rows.activity_logs = [];
  const notArrived = await call(handler, { body: { bookingId: 'b1', action: 'start' } });
  assert.equal(notArrived.statusCode, 409, "only after I've arrived");
  db.rows.bookings[0].assembler_id = 'someone-else';
  assert.equal((await call(handler, { body: { bookingId: 'b1', action: 'start' } })).statusCode, 404, 'only the assigned Easer');
}

// ── 5. Extra work, end to end ────────────────────────────────────────────────
{
  const booking = { id: 'b2', ref: 'AAE-2', service: 'Furniture Assembly', status: 'in_progress', payment_status: 'authorized', payment_method_type: 'card', total_price: 100, customer_name: 'Jordan Reyes', customer_email: 'c@example.com', assembler_id: EASER, assembler_name: 'Pat Doe', assembler_accepted_at: '2026-10-14T00:00:00Z', stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1' };
  const db = memoryDb({ bookings: [booking], booking_change_orders: [] });
  const created = [];
  const { handler } = await loadHandler('api/booking/extra-work.js', {
    ...commonDeps(db),
    getBookingCatalog: pricing.getBookingCatalog,
    calculateBookingPricing: pricing.calculateBookingPricing,
    priceChangeOrder: changeOrders.priceChangeOrder,
    changeOrderEligibility: changeOrders.changeOrderEligibility,
    loadChangeOrders: (ids, o) => changeOrders.loadChangeOrders(ids, o),
    summarizeChangeOrders: changeOrders.summarizeChangeOrders,
    createChangeOrderRequest: async (_sb, input) => { created.push(input); return { ok: true, created: { id: 'co-1' }, priced: input.priced, emailResult: { ok: true } }; },
  });
  const options = await call(handler, { method: 'GET', query: { bookingId: 'b2' } });
  assert.equal(options.statusCode, 200);
  assert.equal(options.body.canAdd, true);
  assert.equal(options.body.services[0].name, 'Furniture Assembly', "the job's own service first");
  assert.ok(!JSON.stringify(options.body).includes('"price"'), 'the Easer never sees a price');
  const catalog = pricing.getBookingCatalog();
  const tv = catalog.subcategories['Mounting & Hanging'].flatMap(g => g.items).find(i => /TV 41/.test(i.name));
  const sentWork = await call(handler, { body: { bookingId: 'b2', items: [{ service: 'Mounting & Hanging', name: tv.name, qty: 1, price: 1 }], note: 'Living room wall' } });
  assert.equal(sentWork.statusCode, 200, JSON.stringify(sentWork.body));
  assert.equal(created[0].priced.subtotalCents, Math.round(tv.price * 100), 'priced from the catalog, never from the request');
  assert.equal(created[0].createdBy, 'easer');
  assert.equal(created[0].requestedByEaserId, EASER);
  assert.match(created[0].description, /^Added on site: 1 × TV 41/);
  const bad = await call(handler, { body: { bookingId: 'b2', items: [{ service: 'Mounting & Hanging', name: 'Free money', qty: 1 }] } });
  assert.equal(bad.statusCode, 400, 'only catalog items');
  db.rows.bookings[0].stripe_payment_method_id = null;
  const noCard = await call(handler, { method: 'GET', query: { bookingId: 'b2' } });
  assert.equal(noCard.body.canAdd, false);
  assert.match(noCard.body.reason, /Get help/, 'the Easer is told what to do, not the owner reason');
  const shared = read('api/booking/_change-order-request.js');
  assert.match(shared, /created_by: createdBy,/, 'one way to request a change order');
  assert.match(read('api/owner/change-order.js'), /createChangeOrderRequest\(sb, \{[\s\S]{0,200}createdBy: 'owner'/, 'the owner uses the same path');
}

// ── 7. Propose a new time ────────────────────────────────────────────────────
{
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const booking = { id: 'b3', ref: 'AAE-3', service: 'Furniture Assembly', status: 'confirmed', date: future, time: '10:00 AM - 12:00 PM', payment_status: 'authorized', assembler_id: EASER, assembler_name: 'Pat Doe', assembler_accepted_at: '2026-10-14T00:00:00Z', customer_email: 'c@example.com', customer_phone: '+15125550100', sms_consent_at: '2026-10-01T00:00:00Z', guest_mutation_token_hash: 'h' };
  const db = memoryDb({ bookings: [booking], easer_time_proposals: [], activity_logs: [], profiles: [{ id: EASER, email: 'e@example.com', full_name: 'Pat Doe' }] });
  const reschedule = await import('../api/booking/reschedule.js');
  const proposals = await import('../api/booking/_time-proposals.js');
  const appt = await import('../api/booking/_appt-date.js');
  const windowMod = await import('../api/booking/_booking-window.js');
  const { handler } = await loadHandler('api/booking/time-proposal.js', {
    ...commonDeps(db),
    rateLimit: async () => true,
    // The booking-link check (api/booking/_customer-access.js), with this test's token.
    usesCustomerAccount: (req, { token } = {}) => !token && /^Bearer /.test(req.headers?.authorization || ''),
    customerBookingAccess: async (_sb, _req, b, { email, token } = {}) => ({ ok: !!token && b.customer_email === email && token === 'tok' && b.guest_mutation_token_hash === 'h' }),
    appointmentTimestampMs: appt.appointmentTimestampMs,
    formatAppointmentDate: appt.formatAppointmentDate,
    formatAppointmentDateShort: appt.formatAppointmentDateShort,
    formatSlotShort: appt.formatSlotShort,
    validateBookingWindowDate: windowMod.validateBookingWindowDate,
    BOOKING_WINDOW_DAYS: windowMod.BOOKING_WINDOW_DAYS,
    TIME_SLOTS: reschedule.TIME_SLOTS,
    validatePublishedRescheduleSlot: reschedule.validatePublishedRescheduleSlot,
    reschedulePaymentConflict: () => null,
    loadOpenProposal: proposals.loadOpenProposal,
    PROPOSAL_STATUS: proposals.PROPOSAL_STATUS,
  });
  const info = await call(handler, { method: 'GET', query: { bookingId: 'b3' } });
  assert.equal(info.body.canPropose, true);
  assert.deepEqual(info.body.slots, reschedule.TIME_SLOTS, 'the same windows the customer books');
  const newDate = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  assert.equal((await call(handler, { body: { bookingId: 'b3', action: 'propose', date: newDate, time: '3:15 PM' } })).statusCode, 400, 'only the booking windows');
  assert.equal((await call(handler, { body: { bookingId: 'b3', action: 'propose', date: future, time: '10:00 AM - 12:00 PM' } })).statusCode, 400, 'not the time already booked');
  assert.equal((await call(handler, { body: { bookingId: 'b3', action: 'propose', date: '2020-01-01', time: '2:00 PM - 4:00 PM' } })).statusCode, 400, 'not a past date');
  sent.texts.length = 0;
  const proposed = await call(handler, { body: { bookingId: 'b3', action: 'propose', date: newDate, time: '2:00 PM - 4:00 PM' } });
  assert.equal(proposed.statusCode, 200, JSON.stringify(proposed.body));
  assert.match(sent.texts.at(-1).body, /proposed a new time/);
  assert.equal((await call(handler, { body: { bookingId: 'b3', action: 'propose', date: newDate, time: '4:00 PM - 6:00 PM' } })).statusCode, 409, 'one open proposal at a time');
  const open = db.rows.easer_time_proposals[0];
  const match = await matchingProposal(db, { proposalId: open.id, booking: db.rows.bookings[0], date: newDate, time: '2:00 PM - 4:00 PM' });
  assert.ok(match, 'the matching reschedule keeps this Easer');
  assert.equal(await matchingProposal(db, { proposalId: open.id, booking: db.rows.bookings[0], date: newDate, time: '4:00 PM - 6:00 PM' }), null, 'another slot does not');
  assert.equal(await matchingProposal(db, { proposalId: open.id, booking: { ...db.rows.bookings[0], assembler_id: 'other' }, date: newDate, time: '2:00 PM - 4:00 PM' }), null, 'nor another Easer');
  const declined = await call(handler, { body: { action: 'decline', ref: 'AAE-3', email: 'c@example.com', token: 'tok', proposalId: open.id } });
  assert.equal(declined.statusCode, 200);
  assert.equal(db.rows.easer_time_proposals[0].status, 'declined');
  assert.equal((await call(handler, { body: { action: 'decline', ref: 'AAE-3', email: 'c@example.com', token: 'wrong', proposalId: open.id } })).statusCode, 404, 'only the booking link declines');
  db.rows.bookings[0].status = 'en_route';
  assert.equal((await call(handler, { method: 'GET', query: { bookingId: 'b3' } })).body.canPropose, false, 'not once travel starts');

  const rescheduleSource = read('api/booking/reschedule.js');
  assert.match(rescheduleSource, /const acceptedProposal = await matchingProposal[\s\S]{0,200}const countsAsReschedule = !acceptedProposal;\s*if \(countsAsReschedule && priorReschedules >= MAX_RESCHEDULES\)/, "the pro's move does not use the customer's reschedules");
  assert.match(rescheduleSource, /reschedule_count: countsAsReschedule \? priorReschedules \+ 1 : priorReschedules,/, 'nor forfeit the free-cancellation window (Rule 9)');
  assert.match(rescheduleSource, /const reconfirmationRequired = Boolean\(booking\.assembler_id\) && !acceptedProposal;/, 'the Easer keeps the job they proposed');
  assert.match(read('api/booking/track.js'), /easer_time_proposal: easerTimeProposal,/, 'the booking page shows it');
  assert.match(read('track.html'), /proposalId: proposalId \}\) \}\)/, 'accepting goes through reschedule with the proposal');
}

// ── 11. Customer rating ──────────────────────────────────────────────────────
{
  const db = memoryDb({ bookings: [{ id: 'b4', ref: 'AAE-4', status: 'completed', assembler_id: EASER, assembler_name: 'Pat Doe', customer_name: 'Jordan Reyes', customer_email: 'c@example.com' }], customer_feedback: [], activity_logs: [], profiles: [{ id: EASER, full_name: 'Pat Doe' }] });
  const { handler } = await loadHandler('api/booking/customer-feedback.js', { ...commonDeps(db), loadCrew: async () => new Map() });
  sent.cases.length = 0; sent.emails.length = 0;
  assert.equal((await call(handler, { body: { bookingId: 'b4' } })).statusCode, 400, 'a rating or a flag');
  assert.equal((await call(handler, { body: { bookingId: 'b4', rating: 6 } })).statusCode, 400);
  const rated = await call(handler, { body: { bookingId: 'b4', rating: 4 } });
  assert.equal(rated.statusCode, 200, JSON.stringify(rated.body));
  assert.equal(db.rows.customer_feedback.length, 1);
  assert.equal(sent.emails.length, 0, 'a plain rating does not email the owner');
  const flagged = await call(handler, { body: { bookingId: 'b4', rating: 2, flagged: true, flagReason: 'safety', note: 'Aggressive dog loose' } });
  assert.equal(flagged.statusCode, 200);
  assert.equal(db.rows.customer_feedback.length, 1, 'one per Easer per job');
  assert.equal(sent.cases[0].caseType, 'safety', 'a safety flag opens a case');
  assert.match(sent.emails[0].subject, /^Urgent: Customer flagged/);
  db.rows.bookings[0].status = 'in_progress';
  assert.equal((await call(handler, { body: { bookingId: 'b4', rating: 5 } })).statusCode, 409, 'after the job');
  db.rows.bookings[0].status = 'completed';
  db.rows.bookings[0].assembler_id = 'other';
  assert.equal((await call(handler, { body: { bookingId: 'b4', rating: 5 } })).statusCode, 404, 'only someone on the job');
  assert.match(read('owner/index.html'), /customerFeedbackField\(b\),/, 'the owner sees it on the booking');
}

// ── 9. Releasing an owner-created job ────────────────────────────────────────
{
  const drop = read('api/booking/drop-job.js');
  assert.match(drop, /const demoTestJob = returnToOwner && booking\.is_test_booking === true && await isDemoEaser\(sb, user\.id\);/);
  assert.match(drop, /const classification = demoTestJob \? \{ \.\.\.classified, strikes: 0 \} : classified;/, 'no strike for the App Review test job');
  assert.match(drop, /const strikeRecord = demoTestJob \? \{ ok: true \} : await recordEaserCancellation/);
  assert.match(read('api/booking/my-assignments.js'), /booking\._can_self_drop = !isOwnerManualLiveFlow\(booking, easerProfile\);/, 'the demo account sees I cannot make this job');
}

// ── 1, 4, 6, 8. The app and the website use these ────────────────────────────
{
  const swift = ['EaserViews.swift', 'EaserStore.swift', 'EaserModels.swift', 'EaserAccountViews.swift']
    .map(f => read(`mobile/ios/App/App/${f}`)).join('\n');
  for (const [what, pattern] of [
    ['help sheet', /private struct HelpSheet: View/],
    ['help sends a support type', /"supportType": type\]/],
    ['customer not home', /"\/api\/booking\/customer-unavailable"/],
    ['running late reaches the customer', /"Running about \\\(minutes\) minutes late\. I'm on my way\.",\s*"sender": "assembler",\s*"target": "customer",/],
    ['extra work', /"\/api\/booking\/extra-work"/],
    ['propose a time', /"\/api\/booking\/time-proposal"/],
    ['rate the customer', /"\/api\/booking\/customer-feedback"/],
    ['work preferences', /"\/api\/assembler\/work-preferences"/],
    ['reliability on Today', /ReliabilityCard\(\)/],
    ['reliability loaded', /"\/api\/assembler\/reliability", keep: "reliability"/],
    ['tips on a job', /let tips = job\.tips, tips\.count > 0/],
    ['tips in Earnings', /store\.earnings\?\.tips/],
    ['where a reschedule moved from', /Moved from /],
    ['the job column stays under ten views', /Group \{\s*if let proposal = job\.timeProposal/],
  ]) assert.match(swift, pattern, `app: ${what}`);
  assert.doesNotMatch(swift, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emojis');

  const web = read('assembler/my-assignments.html');
  for (const [what, pattern] of [
    ['job block', /renderJobLifecycle\(b, accepted, isCompleted\),/],
    ['customer not home', /'\/api\/booking\/customer-unavailable'/],
    ['running late', /'Running about ' \+ minutes \+ ' minutes late\. I\\'m on my way\.'/],
    ['extra work', /'\/api\/booking\/extra-work'/],
    ['propose a time', /'\/api\/booking\/time-proposal'/],
    ['rate the customer', /'\/api\/booking\/customer-feedback'/],
  ]) assert.match(web, pattern, `website: ${what}`);
  assert.doesNotMatch(web, /submitStructuredSupport\(this, message, 'customer_unavailable'/, 'one customer-not-home flow, the timed one');
  assert.match(read('assembler/profile.html'), /fetch\('\/api\/assembler\/work-preferences'/, 'website: work preferences');
  assert.match(read('assembler/payouts.html'), /renderTips\(data\.tips\);/, 'website: tips');
}

// ── Migration 110 ────────────────────────────────────────────────────────────
{
  const m = read('api/migrations/110_easer_lifecycle.sql');
  for (const table of ['easer_time_proposals', 'customer_feedback']) {
    assert.match(m, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`), `${table}: RLS`);
    assert.match(m, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`), `${table}: server only`);
  }
  assert.match(m, /ON public\.easer_time_proposals \(booking_id\) WHERE status = 'pending'/, 'one open proposal per job, in the database');
  assert.match(m, /CONSTRAINT customer_feedback_one_per_job UNIQUE \(booking_id, easer_id\)/);
  assert.match(m, /ADD COLUMN IF NOT EXISTS work_services TEXT\[\]/);
  assert.match(m, /NOTIFY pgrst, 'reload schema';\s*$/);
}

console.log('PASS Easer lifecycle: help, customer not home with a 15-minute wait, tips, reliability, extra work priced from the catalog, the pro\'s proposed time (not counted as a customer reschedule), running late, release without a strike for the App Review test job, services and hours read by dispatch, and the private customer rating.');
