import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildMarketRows,
  formatRequest,
} from '../api/owner/market-demand.js';

const [
  ownerUi,
  paymentApi,
  paymentMigration,
  discountCloseApi,
  discountCloseMigration,
  payoutReviewApi,
  liveOpsApi,
  evidenceApi,
  ownerEvidenceApi,
  reviewApi,
  bookUi,
  termsUi,
] = await Promise.all([
  readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/record-manual-payment.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/051_owner_manual_completed_discount_v5.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/close-manual-balance-discount.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/052_owner_manual_balance_discount_close.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/payout-review.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/evidence.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/upload-completion-evidence.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/review-request.js', import.meta.url), 'utf8'),
  readFile(new URL('../book.html', import.meta.url), 'utf8'),
  readFile(new URL('../terms.html', import.meta.url), 'utf8'),
]);

// Discount override remains bounded by Stripe and gross invoice truth.
assert.match(paymentApi, /record_owner_manual_payment_event_v5/);
assert.match(paymentMigration, /v_gross \+ p_amount_cents > v_target_total/);
assert.match(paymentMigration, /v_booking\.payment_collected IS TRUE/);
assert.match(paymentMigration, /COALESCE\(v_booking\.payout_status, 'unpaid'\) <> 'unpaid'/);
assert.match(paymentMigration, /COALESCE\(v_booking\.refund_amount, 0\) > 0/);
assert.match(paymentMigration, /easerEarningsPreservedCents/);
assert.match(ownerUi, /Record it without the discount, then use Refund/);
assert.match(ownerUi, /Easer earnings will not change/);
assert.match(ownerUi, /Close .* as Customer Discount/);
assert.match(ownerUi, /close-manual-balance-discount/);
assert.match(ownerUi, /No customer charge, refund, or Easer payout will be created/);
assert.match(discountCloseApi, /acknowledged !== true/);
assert.match(discountCloseApi, /close_owner_manual_balance_as_discount_v1/);
assert.doesNotMatch(discountCloseApi, /new Stripe|paymentIntents|refunds\.create|transfers\.create/);
assert.match(discountCloseMigration, /v_target_total := v_gross/);
assert.match(discountCloseMigration, /v_discount IS DISTINCT FROM p_expected_discount_cents/);
assert.match(discountCloseMigration, /COALESCE\(v_booking\.payout_status, 'unpaid'\) IN \('paid', 'transferred'\)/);
assert.match(discountCloseMigration, /EXISTS \([\s\S]*public\.payout_ledger/);
assert.match(discountCloseMigration, /easerEarningsPreservedCents/);
assert.match(discountCloseMigration, /noCustomerChargeCreated', TRUE/);
assert.match(discountCloseMigration, /VALUES \(52, 'owner_manual_balance_discount_close'\)/);

// Damage acknowledgment must be explicit, server-checked, logged, and removable
// from Live Ops only after the canonical booking hold is resolved.
assert.match(ownerUi, /damage-review-evidence-cb/);
assert.match(ownerUi, /damage-review-followup-cb/);
assert.match(ownerUi, /damage-review-hold-cb/);
assert.match(payoutReviewApi, /DAMAGE_REVIEW_ACKNOWLEDGEMENT_REQUIRED/);
assert.match(payoutReviewApi, /acknowledgements:\s*\{/);
assert.match(liveOpsApi, /damage_review_status\.eq\.review_required/);
assert.match(liveOpsApi, /booking => booking\.damage_review_status === 'review_required'/);
assert.match(liveOpsApi, /activity-log failure must never hide an/);
assert.doesNotMatch(liveOpsApi, /sevenDaysAgo/);

// Evidence identifies the person in the Easer role while preserving that the
// historical upload came through the owner dashboard in internal metadata.
assert.match(evidenceApi, /uploaded_by_role/);
assert.match(evidenceApi, /role === 'assembler' \? 'Easer'/);
assert.match(ownerEvidenceApi, /actorType: 'easer'/);
assert.match(ownerEvidenceApi, /recordedFrom: 'owner_dashboard'/);
assert.match(ownerUi, /ev\.uploaded_by_role/);

// Customer and Easer communications require visible recipient confirmation;
// review requests can be intentionally resent and remain auditable.
assert.match(ownerUi, /Switch this message from/);
assert.match(ownerUi, /Send this message to/);
assert.match(ownerUi, /Resend Review Request/);
assert.match(reviewApi, /REVIEW_RESEND_CONFIRMATION_REQUIRED/);
assert.match(reviewApi, /disableDedupe: resend/);
assert.match(reviewApi, /review_request_resent/);

// The separate AI script owns its escaping helper, fixing the owner runtime
// error without depending on the later dashboard IIFE scope.
const intelligenceScript = ownerUi.slice(
  ownerUi.indexOf('var _intelRunning = false;'),
  ownerUi.indexOf('</script>', ownerUi.indexOf('var _intelRunning = false;')),
);
assert.match(intelligenceScript, /function intelEsc/);
assert.doesNotMatch(intelligenceScript, /\besc\(/);

// Checkout keeps material acknowledgment but leaves detailed limitation and
// remedy language in Terms instead of presenting a blanket no-refund warning.
assert.match(bookUi, /item-condition and safe-use provisions/);
assert.doesNotMatch(bookUi, /pre-existing wear or brittleness is not refundable/);
assert.doesNotMatch(bookUi, /not responsible for a product&rsquo;s design/);
assert.match(termsUi, /Reassembly, relocation, and pre-owned or used items/);
assert.match(termsUi, /Nothing in this paragraph limits any remedy/);

// Market Demand never turns an unpriced lead into fake $0 revenue.
const marketRows = buildMarketRows([
  {
    city: 'Austin', state: 'TX', zip_code: '78701', requested_service: 'Furniture assembly',
    status: 'new', converted_booking_id: null, estimated_revenue: 0,
  },
  {
    city: 'Dallas', state: 'TX', zip_code: '75201', requested_service: 'TV mounting',
    status: 'new', converted_booking_id: null, estimated_revenue: 12_500,
  },
], new Map());
const austin = marketRows.find(row => row.city === 'Austin');
const dallas = marketRows.find(row => row.city === 'Dallas');
assert.equal(austin.potentialRevenue, null);
assert.equal(austin.pricedRequestCount, 0);
assert.equal(dallas.potentialRevenue, 12_500);
assert.equal(dallas.pricedRequestCount, 1);
assert.equal(formatRequest({ estimated_revenue: 0 }).estimatedRevenue, null);
assert.equal(formatRequest({ estimated_revenue: 0, verified_revenue_cents: 22_500 }).estimatedRevenue, 22_500);
assert.match(ownerUi, /Priced Demand/);
assert.match(ownerUi, /Not priced/);

console.log('Owner override, damage, communication, evidence, consent, and Market Demand checks passed.');
