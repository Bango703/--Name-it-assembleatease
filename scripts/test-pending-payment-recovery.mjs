import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomToken, sha256 } from '../api/_payment-security.js';
import {
  classifyPendingExpiry,
  hasValidGuestPaymentToken,
  isRecoverablePaymentIntentStatus,
  isStandardRecoveryBooking,
  validateBookingPaymentIntent,
} from '../api/booking/_pending-payment-recovery.js';

const booking = {
  id: 'booking-recovery-1',
  status: 'pending',
  payment_status: 'pending',
  total_price: 12_345,
  stripe_payment_intent_id: 'pi_recovery_1',
};
const intent = {
  id: 'pi_recovery_1',
  status: 'requires_payment_method',
  amount: 12_345,
  currency: 'usd',
  capture_method: 'manual',
  metadata: { bookingId: 'booking-recovery-1', type: 'customer_booking' },
};

assert.equal(isStandardRecoveryBooking(booking), true);
assert.equal(isStandardRecoveryBooking({ ...booking, status: 'confirmed' }), false);
assert.equal(isStandardRecoveryBooking({ ...booking, payment_status: 'quote_pending_approval' }), false);
assert.equal(isStandardRecoveryBooking({ ...booking, stripe_payment_intent_id: null }), false);

for (const status of ['requires_payment_method', 'requires_confirmation', 'requires_action']) {
  assert.equal(isRecoverablePaymentIntentStatus(status), true, `${status} should be recoverable`);
}
for (const status of ['requires_capture', 'succeeded', 'canceled', 'processing']) {
  assert.equal(isRecoverablePaymentIntentStatus(status), false, `${status} must not be treated as a card-entry recovery state`);
}

assert.deepEqual(validateBookingPaymentIntent(booking, intent).errors, []);
const tamperCases = [
  [{ ...intent, id: 'pi_other' }, 'payment_intent_id'],
  [{ ...intent, amount: 12_344 }, 'amount'],
  [{ ...intent, currency: 'eur' }, 'currency'],
  [{ ...intent, capture_method: 'automatic' }, 'capture_method'],
  [{ ...intent, metadata: { ...intent.metadata, bookingId: 'booking-other' } }, 'booking_metadata'],
  [{ ...intent, metadata: { ...intent.metadata, type: 'customer_quote' } }, 'payment_type'],
];
for (const [tamperedIntent, expectedError] of tamperCases) {
  const result = validateBookingPaymentIntent(booking, tamperedIntent);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes(expectedError), `${expectedError} mismatch must fail closed`);
}
assert.equal(validateBookingPaymentIntent(
  { ...booking, stripe_customer_id: 'cus_expected' },
  { ...intent, customer: 'cus_other' },
).errors.includes('stripe_customer_id'), true, 'Stripe customer identity must match the booking');
assert.equal(validateBookingPaymentIntent(
  booking,
  { ...intent, livemode: true },
  { expectedLiveMode: false },
).errors.includes('livemode'), true, 'test/live mode mismatch must fail closed');

const rawToken = 'aae_guest_test_token';
assert.equal(hasValidGuestPaymentToken({ guest_mutation_token_hash: sha256(rawToken) }, rawToken), true);
assert.equal(hasValidGuestPaymentToken({ guest_mutation_token_hash: sha256(rawToken) }, 'wrong-token'), false);
assert.equal(hasValidGuestPaymentToken({ guest_mutation_token_hash: null }, rawToken), false);
const rotatedTokenA = randomToken(32);
const rotatedTokenB = randomToken(32);
assert.notEqual(rotatedTokenA, rotatedTokenB, 'each owner-issued continuation link must use a fresh random token');
assert.notEqual(sha256(rotatedTokenA), sha256(rotatedTokenB));

const nowMs = Date.parse('2026-07-13T18:00:00.000Z');
const staleBeforeMs = Date.parse('2026-07-06T18:00:00.000Z');
assert.deepEqual(classifyPendingExpiry({
  status: 'pending', payment_status: 'pending', created_at: '2026-07-01T00:00:00.000Z',
}, { nowMs, staleBeforeMs }), { eligible: true, kind: 'standard_payment', paymentStatus: 'pending' });
assert.equal(classifyPendingExpiry({
  status: 'pending', payment_status: 'pending', created_at: '2026-07-10T00:00:00.000Z',
}, { nowMs, staleBeforeMs }).eligible, false);
assert.deepEqual(classifyPendingExpiry({
  status: 'pending', payment_status: 'quote_pending_approval', created_at: '2026-06-01T00:00:00.000Z',
  quote_expires_at: '2026-07-14T00:00:00.000Z',
}, { nowMs, staleBeforeMs }), { eligible: false, reason: 'quote_not_expired' }, 'quote TTL, not booking age, controls a live quote');
assert.deepEqual(classifyPendingExpiry({
  status: 'pending', payment_status: 'quote_authorization_pending', created_at: '2026-07-12T00:00:00.000Z',
  quote_expires_at: '2026-07-13T17:59:59.000Z',
}, { nowMs, staleBeforeMs }), { eligible: true, kind: 'quote', paymentStatus: 'quote_authorization_pending' });
assert.equal(classifyPendingExpiry({
  status: 'pending', payment_status: 'quote_pending_approval', created_at: '2026-06-01T00:00:00.000Z',
}, { nowMs, staleBeforeMs }).requiresReconciliation, true, 'a quote without its explicit expiry must remain unchanged');
assert.equal(classifyPendingExpiry({
  status: 'pending', payment_status: 'authorized', created_at: '2026-06-01T00:00:00.000Z',
}, { nowMs, staleBeforeMs }).requiresReconciliation, true, 'unknown/authorized pending rows must remain unchanged');

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [ownerSend, recoveryPage, quoteApproval, staleBooking, liveOps, bookingCreate, bookingConfirmed, ownerReconcile, stripeWebhook] = await Promise.all([
  load('api/owner/send-payment-continuation.js'),
  load('api/booking/payment-recovery.js'),
  load('api/owner/quote-approve.js'),
  load('api/cron/stale-booking.js'),
  load('api/owner/live-ops.js'),
  load('api/booking.js'),
  load('api/booking-confirmed.js'),
  load('api/owner/reconcile-payment-authorization.js'),
  load('api/assembler/stripe-webhook.js'),
]);

assert.match(ownerSend, /verifyOwner\(req\)/);
assert.doesNotMatch(ownerSend, /deriveGuestMutationToken/, 'owner continuation must never recreate a deterministic historical guest credential');
assert.match(ownerSend, /const guestToken = randomToken\(32\)/);
assert.match(ownerSend, /guest_mutation_token_hash: nextGuestTokenHash/);
assert.match(ownerSend, /tokenRotation\.eq\('guest_mutation_token_hash', booking\.guest_mutation_token_hash\)/);
assert.match(ownerSend, /validateBookingPaymentIntent/);
assert.match(ownerSend, /payment-recovery\?bookingId=/);
assert.doesNotMatch(ownerSend, /clientSecret/, 'owner email endpoint must never return or email the Stripe client secret');
assert.ok(
  ownerSend.indexOf('if (hasActiveFinancialOperation(booking))') < ownerSend.indexOf('const stripe = new Stripe'),
  'owner continuation must reject a financial lock before reading or mutating Stripe state',
);
assert.ok((ownerSend.match(/\.is\('financial_operation_key', null\)/g) || []).length >= 4, 'every owner continuation state write/verification must fail closed on the financial lock');
assert.match(ownerSend, /payment_recovery_linkage_ambiguous/);
assert.match(ownerSend, /cancelProvenUnlinkedPaymentIntent/);
assert.ok(
  ownerSend.indexOf('const { data: tokenRows') < ownerSend.indexOf('const emailResult = await sendEmail'),
  'the fresh random token hash must be committed before its raw token is emailed',
);
assert.match(ownerSend, /if \(!emailDelivered\)[\s\S]*guest_mutation_token_hash: previousGuestTokenHash/);
assert.match(ownerSend, /\.eq\('guest_mutation_token_hash', nextGuestTokenHash\)/);
assert.match(ownerSend, /payment_recovery_token_rollback_failed/);
assert.match(ownerSend, /dedupeWindowMin: 2/);
assert.doesNotMatch(ownerSend, /disableDedupe: true/, 'rapid duplicate owner sends must preserve the first valid emailed link');

assert.match(recoveryPage, /hasValidGuestPaymentToken\(booking, token\)/);
assert.match(recoveryPage, /validateBookingPaymentIntent\(booking, intent\)/);
assert.match(recoveryPage, /guestMutationToken:token/);
assert.match(recoveryPage, /Cache-Control', 'no-store/);
assert.match(recoveryPage, /Referrer-Policy', 'no-referrer/);
assert.ok(
  recoveryPage.indexOf('if (hasActiveFinancialOperation(booking))') < recoveryPage.indexOf('const stripe = new Stripe'),
  'public recovery must reject a financial lock before Stripe state is read',
);
assert.ok((recoveryPage.match(/\.is\('financial_operation_key', null\)/g) || []).length >= 2);
assert.ok(
  recoveryPage.indexOf('const currentState = await verifyRecoveryStillUnlocked') < recoveryPage.indexOf('clientSecret: intent.client_secret'),
  'public recovery must recheck unlocked DB truth before exposing the Stripe client secret',
);
assert.ok(
  recoveryPage.indexOf("booking.payment_status === 'failed'") < recoveryPage.indexOf("intent.status === 'requires_capture'"),
  'a verified already-authorized failed row must be reset before booking-confirmed runs',
);

assert.match(quoteApproval, /booking\.status !== BOOKING_STATUS\.PENDING/);
assert.match(quoteApproval, /quoteUpdate\.eq\('quote_token_hash', booking\.quote_token_hash\)/);
assert.match(quoteApproval, /\.eq\('payment_status', 'quote_authorization_pending'\)/);
assert.match(quoteApproval, /\.eq\('stripe_payment_intent_id', pi\.id\)/);
assert.match(quoteApproval, /quoteTermsVersion/);
assert.match(quoteApproval, /paymentIntents\.cancel\(paymentIntentId\)/);
assert.match(quoteApproval, /quote_payment_reconciliation_required/);
assert.ok(
  quoteApproval.indexOf('if (hasActiveFinancialOperation(booking))') < quoteApproval.indexOf('const stripe = new Stripe'),
  'quote approval must reject a financial lock before Stripe authorization work',
);
assert.ok((quoteApproval.match(/\.is\('financial_operation_key', null\)/g) || []).length >= 4);
assert.match(quoteApproval, /quote_payment_linkage_ambiguous/);
assert.ok(
  quoteApproval.indexOf('const stillUnlocked = await quoteAuthorizationStillUnlocked') < quoteApproval.indexOf('clientSecret: pi.client_secret'),
  'quote approval must recheck unlocked DB truth before exposing the Stripe client secret',
);

assert.match(bookingCreate, /PAYMENT_RECONCILIATION_REQUIRED/);
assert.match(bookingCreate, /preserveForReconciliation/);
assert.match(bookingCreate, /safeToDeleteBooking/);
assert.match(
  bookingCreate,
  /if \(preserveForReconciliation\)[\s\S]*PAYMENT_RECONCILIATION_REQUIRED[\s\S]*if \(assemblecashRedeemedCents > 0\)/,
  'an unknown Stripe creation or cancellation outcome must return from the preserve path before cleanup',
);

assert.match(bookingConfirmed, /booking\.payment_status === 'authorized' && booking\.status === 'confirmed'/);
assert.match(bookingConfirmed, /\.in\('status', \['pending', 'confirmed'\]\)/);
assert.match(bookingConfirmed, /\.in\('payment_status', \['pending', 'failed', 'authorized'\]\)/);
assert.match(bookingConfirmed, /\.is\('financial_operation_key', null\)/);
assert.match(bookingConfirmed, /current\?\.payment_status === 'authorized' && current\?\.status === 'confirmed'/);

assert.match(ownerReconcile, /verifyOwner\(req\)/);
assert.match(ownerReconcile, /validateBookingPaymentIntent\(booking, intent\)/);
assert.match(ownerReconcile, /intent\.status !== 'requires_capture'/);
assert.match(ownerReconcile, /payment_status: 'authorized'/);
assert.match(ownerReconcile, /status: 'confirmed'/);
assert.match(ownerReconcile, /payment_authorization_reconciled/);

assert.match(stripeWebhook, /stripe\.paymentIntents\.retrieve\(pi\.id\)/);
assert.match(stripeWebhook, /validateBookingPaymentIntent\(existing, liveAuthorization\)/);
assert.match(stripeWebhook, /liveAuthorization\.status !== 'requires_capture'/);
assert.match(stripeWebhook, /existing\.payment_status === 'authorized' && existing\.status === 'confirmed'/);
assert.doesNotMatch(stripeWebhook, /existing\.payment_status === 'authorized' \|\| existing\.status === 'confirmed'/);
assert.match(stripeWebhook, /\.eq\('stripe_payment_intent_id', pi\.id\)/);
assert.match(stripeWebhook, /authorization-cas-failed/);

assert.match(staleBooking, /\.lte\('quote_expires_at', nowIso\)/);
assert.match(staleBooking, /classifyPendingExpiry/);
assert.match(staleBooking, /prepareExternalPaymentForExpiry/);
assert.match(staleBooking, /intent\.status === 'requires_capture'/);
assert.match(staleBooking, /paymentIntents\.cancel\(intent\.id\)/);
assert.match(staleBooking, /\.eq\('payment_status', b\.payment_status\)/);
assert.match(staleBooking, /reconciliationIssues/);

assert.match(liveOps, /LIVE_OPS_ESSENTIAL_DATA_UNAVAILABLE/);
assert.match(liveOps, /return res\.status\(503\)/);
assert.match(liveOps, /const pendingPayment = pendingRows\.filter/);
assert.match(liveOps, /const quoteNeedsPricing = pendingRows\.filter/);
assert.match(liveOps, /const quoteAwaitingApproval = pendingRows\.filter/);
assert.match(liveOps, /const quoteAuthorizationPending = pendingRows\.filter/);
assert.match(liveOps, /const pendingConfirm = pendingPayment/);
assert.match(liveOps, /payment_state_mismatch/);
assert.match(liveOps, /isBookingPaymentReadyForDispatch/);
assert.match(liveOps, /do not treat zero as confirmed/);

console.log('Pending payment recovery, quote expiry, and Live Ops fail-closed checks passed.');
