#!/usr/bin/env node
// Greater Houston automatic dispatch, end to end through the real code
// (owner, 2026-11-18: "verify the Houston automatic-dispatch flow across
// booking creation, payment-hold recovery, Easer offers, and customer
// notifications"; "confirm no regressions in Austin or San Antonio").
//
// Runs the real eligibility step (findEligibleEasers: readiness, market gate,
// demo exclusion, work preferences), the real scheduled-authorization path,
// the real pricing engine and the real stranded/release rules against an
// in-memory database. No network, no Stripe, no Supabase.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isAutomaticDispatchZip, getServiceCallZone, getServiceCallFeeCents, getMinimumPretaxBookingCents,
  SERVICE_CALL_ZONES, isSameServiceMarket,
} from '../api/_source-of-truth.js';
import { calculateBookingPricing } from '../api/_pricing.js';
import { findEligibleEasers } from '../api/booking/_dispatch-internal.js';
import { authorizeScheduledBooking } from '../api/cron/authorize-scheduled-payments.js';
import { addIsoDays, SCHEDULED_AUTHORIZATION_LEAD_DAYS } from '../api/booking/_booking-window.js';
import { strandedReason } from '../api/_stranded-bookings-core.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';

process.env.EASER_MEMBERSHIP_ENABLED = 'false';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS  ${name}`); }

// ── 1. Booking creation ─────────────────────────────────────────────────────
const GREATER_HOUSTON = { Houston: '77002', Katy: '77494', Spring: '77389', Cypress: '77433', 'The Woodlands': '77380', 'Sugar Land': '77479', Pearland: '77584', 'League City': '77573', Pasadena: '77506', Baytown: '77520', Galveston: '77550', Conroe: '77301' };
const CART = { services: ['Mounting & Hanging'], itemsByService: { 'Mounting & Hanging': [{ name: 'TV 41"–55" (standard wall)', qty: 1 }] } };

await check('booking creation: every Greater Houston booking is saved for automatic dispatch in the Greater Houston zone', async () => {
  const bookingApi = read('api/booking.js');
  assert.match(bookingApi, /const requiresOwnerAssignment = !isAutomaticDispatchZip\(zip\);/);
  assert.match(bookingApi, /needs_manual_dispatch: requiresOwnerAssignment,/);
  assert.match(bookingApi, /call_zone: pricingWithPromo\.callZone,/);
  for (const [place, zip] of Object.entries(GREATER_HOUSTON)) {
    assert.equal(!isAutomaticDispatchZip(zip), false, `${place}: needs_manual_dispatch is false`);
    const pricing = calculateBookingPricing({ ...CART, zip });
    assert.equal(pricing.callZone, 'houston_metro', `${place}: zone`);
    assert.equal(pricing.serviceCallFeeCents, 500, `${place}: $5 service call`);
  }
});

await check('booking creation: a Houston price is exactly what it was under the statewide zone', async () => {
  const houston = calculateBookingPricing({ ...CART, zip: '77002' });
  const statewide = calculateBookingPricing({ ...CART, zip: '75201' });
  assert.equal(houston.totalCents, statewide.totalCents);
  assert.equal(houston.taxCents, statewide.taxCents);
  assert.equal(getMinimumPretaxBookingCents('houston_metro'), getMinimumPretaxBookingCents('texas_statewide'));
  assert.equal(SERVICE_CALL_ZONES.houston_metro.label, 'Greater Houston');
});

// ── 2. Payment-hold recovery and scheduled authorization ───────────────────
await check('payment-hold recovery decides by the same rule as booking creation', async () => {
  const confirmed = read('api/booking-confirmed.js');
  assert.match(confirmed, /const requiresOwnerAssignment = !isAutomaticDispatchZip\(booking\.service_zip \|\| ''\);/);
  assert.match(confirmed, /call_zone, service_zip,/);
  assert.equal(!isAutomaticDispatchZip('77494'), false, 'Katy: back to automatic dispatch after the hold clears');
  assert.equal(!isAutomaticDispatchZip('75201'), true, 'Dallas: stays with the owner');
  assert.equal(!isAutomaticDispatchZip(''), true, 'no ZIP: stays with the owner');
  const webhook = read('api/assembler/stripe-webhook.js');
  assert.match(webhook, /existing\.call_zone === 'texas_statewide'\s*\|\| !isAutomaticDispatchZip\(existing\.service_zip \|\| ''\)/,
    'webhook repair: a new Houston booking carries houston_metro, so only the ZIP rule applies');
});

function fakeBookingsDb(initial) {
  const state = { booking: structuredClone(initial), activity: [] };
  const matches = (row, filters) => filters.every(f => (f.kind === 'is' ? row[f.field] == null && f.value == null : row[f.field] === f.value));
  const chain = (filters, terminal) => ({
    eq(field, value) { filters.push({ kind: 'eq', field, value }); return this; },
    is(field, value) { filters.push({ kind: 'is', field, value }); return this; },
    select: terminal, maybeSingle: terminal,
  });
  return {
    state,
    from(table) {
      if (table === 'activity_logs') return { async insert(row) { state.activity.push(row); return { error: null }; } };
      return {
        update(payload) { const f = []; return chain(f, async () => { if (!matches(state.booking, f)) return { data: [], error: null }; Object.assign(state.booking, payload); return { data: [{ id: state.booking.id }], error: null }; }); },
        select() { const f = []; return chain(f, async () => ({ data: matches(state.booking, f) ? structuredClone(state.booking) : null, error: null })); },
      };
    },
  };
}
const scheduledBooking = (zip) => ({
  id: '22222222-2222-4222-8222-222222222222', ref: 'AAE-HOUSTON1', service: 'Mounting & Hanging',
  customer_name: 'Test Customer', customer_email: 'customer@example.com', status: 'confirmed', payment_status: 'card_saved',
  date: '2026-12-10', time: '9:00 AM - 11:00 AM', total_price: 13423, stripe_customer_id: 'cus_test', stripe_payment_method_id: 'pm_test',
  stripe_payment_intent_id: null, service_zip: zip, assembler_id: null,
  financial_operation_key: null, financial_operation_type: null, financial_operation_started_at: null,
});
const stripeOk = (b) => ({
  paymentIntents: {
    async create() { return { id: 'pi_h', amount: b.total_price, currency: 'usd', customer: 'cus_test', payment_method: 'pm_test', capture_method: 'manual', livemode: false, status: 'requires_confirmation', metadata: { bookingId: b.id, bookingRef: b.ref, type: 'customer_booking', scheduledAuthorization: 'true', appointmentDate: b.date } }; },
    async confirm() { return { id: 'pi_h', amount: b.total_price, currency: 'usd', customer: 'cus_test', payment_method: 'pm_test', capture_method: 'manual', livemode: false, status: 'requires_capture', amount_capturable: b.total_price, metadata: { bookingId: b.id, bookingRef: b.ref, type: 'customer_booking', scheduledAuthorization: 'true', appointmentDate: b.date } }; },
    async cancel() { throw new Error('must not cancel'); },
  },
});

async function authorize(zip) {
  const b = scheduledBooking(zip);
  const sb = fakeBookingsDb(b);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const outcome = await authorizeScheduledBooking({ sb, stripe: stripeOk(b), booking: b, expectedLivemode: false, todayIso: addIsoDays(b.date, -SCHEDULED_AUTHORIZATION_LEAD_DAYS) });
    return { outcome, booking: sb.state.booking, dispatchAttempted: errors.some(e => e.includes('[scheduled-auth] dispatch failed')) };
  } finally { console.error = original; }
}

await check('scheduled authorization: a Katy booking goes to automatic dispatch the moment its hold succeeds', async () => {
  const r = await authorize('77494');
  assert.deepEqual(r.outcome, { ok: true, authorized: true });
  assert.equal(r.booking.payment_status, 'authorized');
  assert.equal(r.booking.needs_manual_dispatch, false);
  assert.equal(r.dispatchAttempted, true, 'the real dispatchBooking was called (it stops here only because the test has no database)');
});

await check('scheduled authorization: a Dallas booking still waits for the owner and is not dispatched', async () => {
  const r = await authorize('75201');
  assert.equal(r.booking.needs_manual_dispatch, true);
  assert.equal(r.dispatchAttempted, false);
});

// ── 3. Easer offers: the real eligibility step ──────────────────────────────
const readyBase = {
  role: 'assembler', application_status: 'approved', status: 'active', tier: 'starter', identity_verified: true,
  is_available: true, phone: '+1 737 555 0100', sms_consent_at: '2026-07-12T12:00:00.000Z',
  contractor_agreement_signed_at: '2026-07-12T12:00:00.000Z', contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-07-12T12:00:00.000Z', application_fee_waived: true, account_closure_status: null,
};
const EASERS = [
  { ...readyBase, id: 'houston-ready', full_name: 'Houston Ready', zip: '77002', city: 'Houston' },
  { ...readyBase, id: 'houston-not-approved', full_name: 'Houston Applicant', zip: '77546', city: 'Friendswood', application_status: 'applied' },
  { ...readyBase, id: 'houston-no-agreement', full_name: 'Houston No Agreement', zip: '77380', city: 'The Woodlands', contractor_agreement_signed_at: null },
  { ...readyBase, id: 'austin-ready', full_name: 'Austin Ready', zip: '78701', city: 'Austin' },
  { ...readyBase, id: 'sa-ready', full_name: 'San Antonio Ready', zip: '78205', city: 'San Antonio' },
  { ...readyBase, id: 'houston-demo', full_name: 'Demo', zip: '77002', city: 'Houston' },
];
function fakeProfilesDb() {
  const chainFor = (columns) => {
    const filters = [];
    const result = () => {
      if (columns === 'id') return { data: [{ id: 'houston-demo' }], error: null }; // demo accounts
      if (columns.startsWith('id, work_services')) return { data: [], error: null };  // no work preferences set
      const rows = EASERS.filter(e => filters.every(([k, v]) => e[k] === v));
      return { data: rows, error: null };
    };
    const c = {
      eq(k, v) { filters.push([k, v]); return c; }, in() { return c; }, or() { return c; }, not() { return c; },
      is() { return c; }, order() { return c; }, limit() { return c; },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return c;
  };
  return { from(table) { assert.equal(table, 'profiles'); return { select: (cols) => chainFor(String(cols)) }; } };
}

async function eligibleFor(zip) {
  const found = await findEligibleEasers(fakeProfilesDb(), { id: 'b', service: 'Mounting & Hanging', service_zip: zip, address: `1 Main St, TX ${zip}`, date: '2026-12-10', time: '9:00 AM - 11:00 AM' });
  return found.easers.map(e => e.id).sort();
}

await check('Easer offers: a Greater Houston job reaches only the ready Houston Easer', async () => {
  for (const [place, zip] of Object.entries({ Katy: '77494', Spring: '77389', Pearland: '77584', Galveston: '77550' })) {
    assert.deepEqual(await eligibleFor(zip), ['houston-ready'], place);
  }
});

await check('Easer offers: not approved, no agreement and demo accounts never get a Houston offer', async () => {
  const ids = await eligibleFor('77002');
  for (const id of ['houston-not-approved', 'houston-no-agreement', 'houston-demo']) assert.ok(!ids.includes(id), id);
});

await check('Austin and San Antonio offers are unchanged and never cross into Houston', async () => {
  assert.deepEqual(await eligibleFor('78701'), ['austin-ready']);
  assert.deepEqual(await eligibleFor('78205'), ['sa-ready']);
  assert.equal(isSameServiceMarket('78701', '77002'), false);
  assert.equal(isSameServiceMarket('78205', '77002'), false);
});

// ── 4. Customer and owner notifications ─────────────────────────────────────
await check('customer confirmation: Houston bookings get the automatic message, not "reviewing availability"', async () => {
  const confirmed = read('api/booking-confirmed.js');
  const m = confirmed.match(/const assignmentLine = booking\.needs_manual_dispatch\s*\?\s*`([^`]*)`\s*:\s*`([^`]*)`/);
  assert.ok(m, 'assignment line exists');
  assert.match(m[1], /reviewing local Easer availability/, 'manual wording unchanged for areas outside automatic dispatch');
  assert.match(m[2], /matching you with a verified Easer/, 'automatic wording');
  // needs_manual_dispatch is false for every Greater Houston ZIP (checks 1 and 2), so the second line is sent.
});

await check('owner surfaces: a Houston booking is never called "outside the automatic dispatch area"', async () => {
  const houstonUnassigned = { status: 'confirmed', assembler_id: null, needs_manual_dispatch: !isAutomaticDispatchZip('77494'), dispatch_paused: false, service_zip: '77494', created_at: new Date(Date.now() - 3600000).toISOString() };
  assert.doesNotMatch(String(strandedReason(houstonUnassigned)), /outside the automatic dispatch area/);
  const releaseSrc = read('api/booking/release-assignment.js');
  assert.match(releaseSrc, /const needsManualDispatch = !isAutomaticDispatchZip\(serviceZip\);/, 'a released Houston job returns to automatic dispatch');
  const createSrc = read('api/owner/create-booking.js');
  assert.match(createSrc, /insertPayload\.needs_manual_dispatch = !isAutomaticDispatchZip\(serviceLocation\.zip\);/, 'owner-created Houston jobs dispatch automatically');
  const rebookSrc = read('api/booking/rebook-payment.js');
  assert.match(rebookSrc, /const automaticDispatch = isAutomaticDispatchZip\(booking\.service_zip \|\| ''\);/);
});

// ── 5. Austin and San Antonio zones and prices unchanged ────────────────────
await check('Austin and San Antonio: zones, fees, minimums and dispatch unchanged', async () => {
  const expectations = { '78701': 'austin_core', '78660': 'near_suburb', '78205': 'near_suburb', '78006': 'near_suburb', '78130': 'near_suburb' };
  for (const [zip, zone] of Object.entries(expectations)) {
    assert.equal(getServiceCallZone(zip), zone, zip);
    assert.equal(isAutomaticDispatchZip(zip), true, zip);
    assert.equal(getServiceCallFeeCents(zip), 500, zip);
  }
  assert.equal(getMinimumPretaxBookingCents('austin_core'), 12900);
  assert.equal(getMinimumPretaxBookingCents('near_suburb'), 14900);
  for (const zip of ['78040', '75201', '79401', '77801']) assert.equal(isAutomaticDispatchZip(zip), false, `${zip} still owner-assigned`);
});

console.log(`\nHouston automatic dispatch flow: ${passed} checks passed.`);
