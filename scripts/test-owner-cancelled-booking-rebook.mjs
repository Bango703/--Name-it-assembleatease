import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  normalizeRebookSourceId,
  validateOwnerRebookSource,
} from '../api/owner/_rebook.js';
import { isBookingPaymentReadyForDispatch } from '../api/_source-of-truth.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const cancelled = {
  id: UUID,
  ref: 'AAE-CANCELLED',
  status: 'cancelled',
  source: 'online',
  payment_status: 'authorization_released',
  stripe_payment_intent_id: 'pi_released',
  financial_operation_key: null,
  financial_reconciliation_required_at: null,
  cancellation_reconciliation_required_at: null,
};

assert.equal(normalizeRebookSourceId(UUID), UUID);
assert.equal(normalizeRebookSourceId('not-a-booking-id'), null);
assert.equal(validateOwnerRebookSource(cancelled).ok, true);
assert.equal(validateOwnerRebookSource({ ...cancelled, status: 'confirmed' }).code, 'REBOOK_CANCELLED_SOURCE_REQUIRED');
assert.equal(validateOwnerRebookSource({ ...cancelled, financial_operation_key: 'cancel:owner:1' }).code, 'REBOOK_SOURCE_RECONCILIATION_REQUIRED');
assert.equal(validateOwnerRebookSource({ ...cancelled, payment_status: 'authorized' }).code, 'REBOOK_SOURCE_PAYMENT_UNSETTLED');
assert.equal(validateOwnerRebookSource({ ...cancelled, payment_status: 'cancellation_fee_captured' }).ok, true);
assert.equal(validateOwnerRebookSource({
  ...cancelled,
  source: 'owner_manual',
  stripe_payment_intent_id: null,
  payment_status: 'offline_recorded',
  payment_collected: true,
  amount_charged: 15_000,
  refund_amount: 0,
}).code, 'REBOOK_SOURCE_OFFLINE_PAYMENT_UNSETTLED');
assert.equal(validateOwnerRebookSource({
  ...cancelled,
  source: 'owner_manual',
  stripe_payment_intent_id: null,
  payment_status: 'offline_recorded',
  payment_collected: true,
  amount_charged: 15_000,
  refund_amount: 15_000,
}).ok, true);

const dispatchReady = {
  total_price: 12_500,
  payment_status: 'authorized',
  stripe_payment_intent_id: 'pi_authorized',
};
assert.equal(isBookingPaymentReadyForDispatch(dispatchReady), true);
assert.equal(isBookingPaymentReadyForDispatch({ ...dispatchReady, financial_reconciliation_required_at: new Date().toISOString() }), false);
assert.equal(isBookingPaymentReadyForDispatch({ ...dispatchReady, cancellation_reconciliation_required_at: new Date().toISOString() }), false);

const [
  ownerUi, createApi, editApi, resendApi, rebookPaymentApi, rebookEmail,
  bookingConfirmed, paymentRecovery, scheduledAuthorization, stripeWebhook,
  dispatchInternal, sourceTruth, migration,
] = await Promise.all([
  readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/create-booking.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/edit-booking.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/send-rebook-payment.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/rebook-payment.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/_rebook-payment-email.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking-confirmed.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/payment-recovery.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/cron/authorize-scheduled-payments.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/assembler/stripe-webhook.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/_dispatch-internal.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/_source-of-truth.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/067_cancelled_booking_rebook_lineage.sql', import.meta.url), 'utf8'),
]);

assert.match(ownerUi, /data-action="rebook"/);
assert.match(ownerUi, /Review &amp; Rebook/);
assert.match(ownerUi, /data-action="open-rebooking"/);
assert.match(ownerUi, /item\.rebooked_from_booking_id === b\.id/);
assert.match(ownerUi, /function openOwnerCreateBookingModal\(rebookSource\)/);
assert.match(ownerUi, /no old payment or Easer assignment will be reused/i);
assert.match(ownerUi, /rebookedFromBookingId:/);
assert.match(ownerUi, /sourceInput\.value = rebookSource\.id/);
assert.match(ownerUi, /setValue\('ocb-details', rebookSource\.details \|\| ''\)/);
assert.match(ownerUi, /methodInput\.value = ''/);
assert.match(ownerUi, /customerTerms\.checked = false/);
assert.match(ownerUi, /d\.code === 'REBOOK_ALREADY_CREATED'/);
assert.match(ownerUi, /selectBooking\(d\.existingBookingId\)/);
assert.match(ownerUi, /Create and Email Payment Link/);
assert.match(ownerUi, /Resend Payment Method Link/);
assert.match(ownerUi, /\/api\/owner\/send-rebook-payment/);
assert.match(ownerUi, /b\.dispatch_status === 'payment_hold'[\s\S]*Email Secure Payment Link/);

assert.match(createApi, /validateOwnerRebookSource\(sourceBooking\)/);
assert.match(createApi, /code: 'REBOOK_MUST_BE_NEW_APPOINTMENT'/);
assert.match(createApi, /cleanDate < chicagoDateIso\(\)/);
assert.match(createApi, /insertPayload\.rebooked_from_booking_id = rebookSource\.id/);
assert.match(createApi, /details: cleanDetails/);
assert.match(createApi, /eventType: 'booking_rebooked'/);
assert.match(createApi, /paymentReused: false/);
assert.match(createApi, /assignmentReused: false/);
assert.match(createApi, /No payment or authorization from the cancelled booking was reused/);
assert.match(createApi, /code: 'REBOOK_ALREADY_CREATED'/);
assert.match(createApi, /status: isCardRebook \? 'pending'/);
assert.match(createApi, /payment_status: isCardRebook \? 'pending'/);
assert.match(createApi, /source: isCardRebook \? 'online'/);
assert.match(createApi, /dispatch_status = 'payment_hold'/);
assert.match(createApi, /sendRebookPaymentEmail/);
assert.match(createApi, /REBOOK_TOKEN_CLEANUP_REVIEW_REQUIRED/);
assert.doesNotMatch(createApi, /insertPayload\.(?:stripe_payment_intent_id|assembler_id|refund_id|payout_status)\s*=/);

assert.match(editApi, /REBOOK_SCOPE_LOCKED/);
assert.match(editApi, /REBOOK_SCHEDULE_LOCKED_AFTER_PAYMENT_STARTED/);
assert.match(editApi, /validateBookingWindowDate/);

assert.match(resendApi, /verifyOwner\(req\)/);
assert.match(resendApi, /const token = randomToken\(32\)/);
assert.match(resendApi, /guest_mutation_token_hash: nextHash/);
assert.match(resendApi, /financial_reconciliation_required_at/);
assert.match(resendApi, /sendRebookPaymentEmail/);

assert.match(rebookPaymentApi, /safeTokenHashMatch\(token, booking\.guest_mutation_token_hash\)/);
assert.match(rebookPaymentApi, /needsScheduledAuthorization\(booking\.date\)/);
assert.match(rebookPaymentApi, /capture_method: 'manual'/);
assert.match(rebookPaymentApi, /setupIntents\.create/);
assert.match(rebookPaymentApi, /payment_status: 'card_saved'/);
assert.match(rebookPaymentApi, /dispatch_paused: true/);
assert.match(rebookPaymentApi, /validateBookingPaymentIntent/);
assert.match(rebookPaymentApi, /REBOOK_PAYMENT_RECONCILIATION_REQUIRED/);
assert.match(rebookPaymentApi, /financial_reconciliation_required_at/);
assert.doesNotMatch(rebookPaymentApi, /paymentIntents\.capture/);

assert.match(rebookEmail, /Complete your rebooking/);
assert.match(rebookEmail, /Add payment method/);
assert.match(rebookEmail, /Nothing is charged when you add your card/);

assert.match(bookingConfirmed, /cancellation_reconciliation_required_at/);
assert.match(paymentRecovery, /financial_reconciliation_required_at/);
assert.match(scheduledAuthorization, /const token = randomToken\(32\)/);
assert.match(scheduledAuthorization, /guest_mutation_token_hash: nextHash/);
assert.doesNotMatch(scheduledAuthorization, /deriveGuestMutationToken/);
assert.match(stripeWebhook, /isAutomaticDispatchZip/);
assert.match(stripeWebhook, /needs_manual_dispatch: requiresOwnerAssignment/);
assert.match(stripeWebhook, /financial_reconciliation_required_at/);
assert.match(dispatchInternal, /financial_reconciliation_required_at/);
assert.match(sourceTruth, /cancellation_reconciliation_required_at/);

assert.match(migration, /rebooked_from_booking_id UUID REFERENCES public\.bookings\(id\) ON DELETE SET NULL/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_rebooked_from_booking_id/);
assert.match(migration, /bookings_rebook_source_not_self/);
assert.match(migration, /VALUES \(67, 'cancelled_booking_rebook_lineage'\)/);
assert.equal((migration.match(/^BEGIN;$/gm) || []).length, 1);
assert.equal((migration.match(/^COMMIT;$/gm) || []).length, 1);

console.log('Owner cancelled-booking rebook lineage and payment-isolation checks: PASS');
