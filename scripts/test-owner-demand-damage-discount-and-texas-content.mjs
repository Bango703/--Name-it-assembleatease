import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseServiceLocation } from '../api/_booking-location.js';
import { buildMarketRows, formatBookingSignal } from '../api/owner/market-demand.js';
import { discountFailure, loadDiscountEligibility } from '../api/owner/close-manual-balance-discount.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => readFile(path.join(root, file), 'utf8');

assert.deepEqual(parseServiceLocation({ address: '100 Main St, Houston, TX 77002' }), { city: 'Houston', state: 'TX', zip: '77002' });
assert.deepEqual(parseServiceLocation({ address: '6904 Shumard Circle, Austin, tx, 78759' }), { city: 'Austin', state: 'TX', zip: '78759' });
assert.deepEqual(parseServiceLocation({ address: '500 Street', city: 'El Paso', state: 'TX', zip: '79901' }), { city: 'El Paso', state: 'TX', zip: '79901' });

const houstonBooking = formatBookingSignal({
  id: 'booking-houston', ref: 'AAE-HOUSTON', source: 'website', status: 'confirmed', payment_status: 'authorized',
  customer_name: 'Customer', service: 'Furniture Assembly', date: '2026-08-02', time: '1:00 PM - 3:00 PM',
  address: '100 Main St, Houston, TX 77002', total_price: 22500, needs_manual_dispatch: true,
  created_at: '2026-08-01T12:00:00.000Z',
});
assert.equal(houstonBooking.city, 'Houston');
assert.equal(houstonBooking.zip, '77002');
assert.equal(houstonBooking.recordType, 'booking');
assert.equal(houstonBooking.needsManualDispatch, true);

const rows = buildMarketRows([
  houstonBooking,
  { recordType: 'request', city: 'Houston', state: 'TX', zip: '77003', requestedService: 'TV Mounting', status: 'new', estimatedRevenue: null },
], new Map());
const houston = rows.find(row => row.city === 'Houston');
assert.equal(houston.requestCount, 2);
assert.equal(houston.bookedCount, 1);
assert.equal(houston.unbookedCount, 1);
assert.equal(houston.manualDispatchCount, 1);
assert.equal(houston.potentialRevenue, 22500);

function queryResult(result) {
  return {
    select() { return this; },
    eq() { return this; },
    limit() { return Promise.resolve(result); },
    maybeSingle() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
}
const kellyEligibility = await loadDiscountEligibility({
  from(table) {
    if (table === 'bookings') return queryResult({ data: {
      id: 'kelly-booking', ref: 'AAE-URF7O9P3XY', source: 'owner_manual', status: 'completed',
      payment_status: 'offline_recorded', total_price: 37965, payment_collected: false, payout_status: 'pending',
      stripe_transfer_id: null, financial_operation_key: null, financial_operation_type: null,
      financial_operation_started_at: null, financial_reconciliation_required_at: null,
    }, error: null });
    if (table === 'owner_manual_payment_events') return queryResult({ data: [
      { amount_cents: 14900, refunded_cents: 0, processing_fee_cents: 407 },
      { amount_cents: 22500, refunded_cents: 0, processing_fee_cents: 613 },
    ], error: null });
    if (table === 'payout_ledger') return queryResult({ data: [], error: null });
    if (table === 'platform_schema_state') return queryResult({ data: { migration_number: 55 }, error: null });
    throw new Error(`Unexpected table: ${table}`);
  },
}, 'kelly-booking');
assert.equal(kellyEligibility.eligible, true);
assert.equal(kellyEligibility.grossCollectedCents, 37400);
assert.equal(kellyEligibility.discountCents, 565);
assert.deepEqual(discountFailure({ code: '42702', message: 'column reference "booking_id" is ambiguous' }), {
  status: 503,
  code: 'MIGRATION_055_REQUIRED',
  error: 'The balance-discount database function is outdated. Apply migration 055; no money or invoice amount was changed.',
});

const [marketApi, bookingApi, ownerBookingApi, ownerUi, damageUpload, damageResolution, casesApi, caseAction, discountApi, migration, discountFixMigration, blogIndex, texasGuide, sitemap] = await Promise.all([
  source('api/owner/market-demand.js'), source('api/booking.js'), source('api/owner/create-booking.js'), source('owner/index.html'),
  source('api/booking/upload-evidence.js'), source('api/booking/payout-review.js'), source('api/owner/cases.js'), source('api/owner/case-action.js'),
  source('api/owner/close-manual-balance-discount.js'), source('api/migrations/054_booking_demand_and_damage_cases.sql'),
  source('api/migrations/055_owner_manual_discount_rpc_ambiguity_fix.sql'),
  source('blog/index.html'), source('blog/texas-furniture-assembly-home-setup-guide.html'), source('sitemap.xml'),
]);

assert.match(marketApi, /loadBookingDemand/);
assert.match(marketApi, /\.from\('bookings'\)/);
assert.match(marketApi, /bookedDemand/);
assert.match(marketApi, /unbookedDemand/);
assert.match(marketApi, /manualDispatchDemand/);
assert.match(marketApi, /unlocatedCount/);
assert.match(bookingApi, /service_city: serviceLocation\.city/);
assert.match(ownerBookingApi, /service_zip: serviceLocation\.zip/);
assert.match(ownerUi, /Demand Signals/);
assert.match(ownerUi, /Real Bookings/);
assert.match(ownerUi, /openDemandBooking/);

assert.match(damageUpload, /createOperationCase/);
assert.match(damageUpload, /damage-booking:\$\{booking\.id\}/);
assert.match(damageUpload, /operationCaseId: damageCase\?\.id/);
assert.match(damageResolution, /resolveLinkedDamageCase/);
assert.match(damageResolution, /caseStatusSynchronized/);
assert.match(casesApi, /requiresBookingDamageResolution/);
assert.match(caseAction, /BOOKING_DAMAGE_REVIEW_REQUIRED/);
assert.match(ownerUi, /Review Steps and Close Alert/);
assert.match(ownerUi, /Review and Close Alert/);

assert.match(discountApi, /req\.method === 'GET'/);
assert.match(discountApi, /loadDiscountEligibility/);
assert.match(discountApi, /owner_manual_payment_events/);
assert.match(discountApi, /payout_ledger/);
assert.match(discountApi, /close_owner_manual_balance_as_discount_v1/);
assert.match(discountApi, /MIGRATION_055_REQUIRED/);
assert.match(ownerUi, /Checking the payment and payout ledgers/);
assert.match(ownerUi, /No new charge, refund, or Easer payout will be created/);

assert.match(discountFixMigration, /#variable_conflict error/);
assert.match(discountFixMigration, /audit_row\.booking_id = p_booking_id/);
assert.doesNotMatch(discountFixMigration, /WHERE\s+booking_id = p_booking_id/i);
assert.match(discountFixMigration, /VALUES \(55, 'owner_manual_discount_rpc_ambiguity_fix'\)/);

assert.match(migration, /ADD COLUMN IF NOT EXISTS service_city/);
assert.match(migration, /damage-booking:/);
assert.match(migration, /VALUES \(54, 'booking_demand_and_damage_cases'\)/);
assert.doesNotMatch(migration, /payment_collected\s*=/);
assert.doesNotMatch(migration, /payout_status\s*=/);
assert.doesNotMatch(migration, /total_price\s*=/);

// The heading used to read "Texas Home Setup Guides" and this asserted that
// exact string. It now reads "Home Setup Guides", which is CORRECT: the city and
// state belong in the title, meta, JSON-LD, service-area block and FAQ — not
// stuffed through body copy. Asserting the old wording made the guard enforce
// the opposite of the platform's own copy rule.
//
// What actually matters is unchanged and still checked: this is the guides
// index, and it links the statewide guide (asserted on the next line) whose
// Texas coverage and no-nationwide-claim are verified below.
assert.match(blogIndex, /Home Setup Guides/);
assert.match(blogIndex, /texas-furniture-assembly-home-setup-guide/);
for (const place of ['Houston', 'Dallas-Fort Worth', 'San Antonio', 'Austin', 'El Paso', 'Amarillo', 'McAllen', 'Corpus Christi']) {
  assert.match(texasGuide, new RegExp(place.replace('-', '\\-'), 'i'));
}
assert.match(texasGuide, /Online booking is available for valid Texas addresses/);
assert.match(texasGuide, /availability.*service address/i);
assert.doesNotMatch(texasGuide, /nationwide (?:booking|service|coverage)/i);
assert.match(sitemap, /blog\/texas-furniture-assembly-home-setup-guide/);

console.log('Owner demand, damage, discount, finance clarity, and statewide content checks: PASS');
