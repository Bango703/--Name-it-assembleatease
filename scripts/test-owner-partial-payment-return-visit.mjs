import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { manualStripeEventMatches } from '../api/owner/_manual-payment-truth.js';

const [
  migration,
  paymentApi,
  scheduleApi,
  payoutApi,
  trackApi,
  ownerUi,
  trackUi,
  liveOps,
  easerStatus,
  easerHome,
  ownerEaserConfiguration,
  sourceOfTruth,
  pricingPage,
] = await Promise.all([
  readFile(new URL('../api/migrations/044_owner_manual_partial_payments_and_return_visits.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/record-manual-payment.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/schedule-return-visit.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/payout.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/track.js', import.meta.url), 'utf8'),
  readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../track.html', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/easer-status.js', import.meta.url), 'utf8'),
  readFile(new URL('../assembler/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../business-artifacts/operations/configure-owner-easer-tg703664.sql', import.meta.url), 'utf8'),
  readFile(new URL('../assets/js/booking-source-of-truth.js', import.meta.url), 'utf8'),
  readFile(new URL('../pricing.html', import.meta.url), 'utf8'),
]);

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.owner_manual_payment_events/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_manual_payment_events_payment_intent/);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_owner_manual_payment_event/);
assert.match(migration, /v_collected = v_target_total/);
assert.match(migration, /v_collected > v_target_total/);
assert.match(migration, /return_visit_remaining_scope/);
assert.match(migration, /guard_owner_manual_payment_aggregate/);
assert.ok(
  migration.indexOf("IF v_pi IS NOT NULL THEN") < migration.indexOf("IF v_booking.total_price IS DISTINCT FROM p_expected_total_cents"),
  'idempotent Stripe retries must be resolved before the discounted-current-total compare',
);

assert.match(paymentApi, /paymentIntents\.retrieve/);
assert.match(paymentApi, /latest_charge\.balance_transaction/);
assert.match(paymentApi, /intent\.status !== 'succeeded'/);
assert.match(paymentApi, /const amountCents = Number\(intent\?\.amount_received\)/);
assert.match(paymentApi, /Number\.isSafeInteger\(amountCents\)/);
assert.match(paymentApi, /expectedTotalCents - submittedDiscountCents/);
assert.match(paymentApi, /Number\(charge\.amount_refunded \|\| 0\) !== 0/);
assert.match(paymentApi, /charge\.disputed === true/);
assert.match(paymentApi, /balanceTransaction\?\.fee/);
assert.match(paymentApi, /metadataBookingId && metadataBookingId !== booking\.id/);
assert.doesNotMatch(paymentApi, /0\.029|Math\.round\(.*processingFee/);

assert.match(scheduleApi, /return_visit_required: true/);
assert.match(scheduleApi, /return_visit_completed_scope/);
assert.match(scheduleApi, /return_visit_remaining_scope/);
assert.match(scheduleApi, /chicagoTodayIso/);
assert.match(scheduleApi, /notificationDelivered === false/);
assert.match(scheduleApi, /\['confirmed', 'en_route', 'arrived', 'in_progress'\]/);

assert.match(payoutApi, /verifyOwnerManualCustomerFundsForPayout/);
assert.match(trackApi, /amount_collected_cents/);
assert.match(trackApi, /remaining_balance_cents/);
assert.doesNotMatch(
  trackApi.slice(trackApi.indexOf('const safe = {')),
  /stripe_payment_intent_id|stripe_charge_id/,
);
assert.match(ownerUi, /Record Customer Payment/);
assert.match(ownerUi, /Schedule Return Visit/);
assert.match(ownerUi, /remainingBalanceCents/);
assert.match(trackUi, /Payment received/);
assert.match(trackUi, /Work remaining/);
assert.match(liveOps, /is_return_visit/);
assert.match(liveOps, /returnVisitsOpen/);
assert.match(easerStatus, /booking\.return_visit_required \? booking\.return_visit_date : booking\.date/);
assert.match(easerStatus, /\.eq\('return_visit_required', true\)/);
assert.match(easerHome, /var upcomingDate = b\.return_visit_required \? b\.return_visit_date : b\.date/);
assert.match(ownerEaserConfiguration, /tg703664@gmail\.com/);
assert.match(ownerEaserConfiguration, /v_target_count <> 1/);
assert.match(ownerEaserConfiguration, /A different owner-Easer profile is already configured/);
assert.match(ownerEaserConfiguration, /SET is_owner = TRUE/);

assert.match(
  sourceOfTruth,
  /Trampoline relocation \(disassembly, transport & reassembly\) — custom quote'.*customQuote: true/,
);
// Assert the SHAPE, not the numbers. This block hardcoded 229/279/329 and had
// been failing since commit c908b32a legitimately raised those prices — a test
// that copies catalog values breaks the build on every real price change, which
// is the same duplicate-truth problem it is supposed to guard against.
//
// What actually matters: the three tiers exist, each carries a price, and the
// prices ASCEND with size. A typo that made the 15 ft tier cheaper than the
// 10 ft tier is a real defect; 279 becoming 289 is not.
// Parsed by string search, not a built regex — the labels contain parentheses,
// a plus sign and an en dash, and escaping those into a dynamic pattern is how
// this kind of check quietly stops matching anything.
const trampolineTiers = ['up to 10 ft', '11–14 ft', '15 ft+'].map((label) => {
  const needle = `Trampoline assembly (${label})'`;
  const at = sourceOfTruth.indexOf(needle);
  assert.ok(at !== -1, `Trampoline assembly (${label}) must exist in the catalog.`);
  const priced = sourceOfTruth.slice(at, at + needle.length + 40).match(/price:\s*(\d+)/);
  assert.ok(priced, `Trampoline assembly (${label}) must carry a price.`);
  return { label, price: Number(priced[1]) };
});
assert.ok(
  trampolineTiers.every((tier, i) => i === 0 || tier.price > trampolineTiers[i - 1].price),
  `Trampoline prices must rise with size — got ${trampolineTiers.map(t => `${t.label}=$${t.price}`).join(', ')}.`,
);

// The customer-facing page must quote the catalog's entry price. This is the
// drift that would actually cost trust: the site advertising a number the
// booking engine no longer charges.
const trampolineFrom = pricingPage.match(/Trampoline assembly \(up to 10 ft\)<\/span><strong>\$(\d+)</);
assert.ok(trampolineFrom, 'pricing.html must advertise the exact up-to-10-ft trampoline price.');
assert.equal(
  Number(trampolineFrom[1]),
  trampolineTiers[0].price,
  `pricing.html advertises $${trampolineFrom && trampolineFrom[1]} but the catalog's entry tier is $${trampolineTiers[0].price}.`,
);
assert.match(sourceOfTruth, /Disassembly only \(customer handles transport\)/);
assert.match(pricingPage, /Trampoline relocation \(disassembly, transport &amp; reassembly\).*Custom quote/);

const event = {
  amount_cents: 14900,
  stripe_payment_intent_id: 'pi_verified',
  stripe_charge_id: 'ch_verified',
};
const successfulIntent = {
  id: 'pi_verified',
  status: 'succeeded',
  currency: 'usd',
  amount_received: 14900,
  livemode: true,
  latest_charge: {
    id: 'ch_verified',
    status: 'succeeded',
    paid: true,
    captured: true,
    currency: 'usd',
    livemode: true,
    payment_intent: 'pi_verified',
    amount_captured: 14900,
    amount_refunded: 0,
    refunded: false,
    disputed: false,
  },
};

assert.equal(manualStripeEventMatches(event, successfulIntent, true), true);
assert.equal(manualStripeEventMatches(event, {
  ...successfulIntent,
  latest_charge: { ...successfulIntent.latest_charge, amount_refunded: 500 },
}, true), false);
assert.equal(manualStripeEventMatches(event, {
  ...successfulIntent,
  latest_charge: { ...successfulIntent.latest_charge, disputed: true },
}, true), false);
assert.equal(manualStripeEventMatches(event, { ...successfulIntent, amount_received: 14899 }, true), false);
assert.equal(manualStripeEventMatches(event, successfulIntent, false), false);
assert.equal(37965 - 500, 37465);
assert.equal(37465 - 14900, 22565);

console.log('Owner partial-payment and return-visit safety checks passed.');
