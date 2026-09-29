import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canRecoverPaymentNow,
  hasValidGuestPaymentToken,
  hasValidPaymentRecoveryToken,
  isActivePaymentRecoveryBooking,
} from '../api/booking/_pending-payment-recovery.js';
import { sha256 } from '../api/_payment-security.js';

const active = status => ({ status, payment_status: 'failed', stripe_payment_intent_id: 'pi_old' });
for (const status of ['en_route', 'arrived', 'in_progress']) {
  assert.equal(canRecoverPaymentNow(active(status)), true);
  assert.equal(isActivePaymentRecoveryBooking(active(status)), true);
  // 'authorized' is deliberately NOT in the shared gate. It also feeds Track
  // My Booking and the owner's send button, and a booking marked authorized
  // owes nothing — including it would put "amount due" in front of a customer
  // whose money is already held.
  assert.equal(canRecoverPaymentNow({ ...active(status), payment_status: 'authorized' }), false,
    'a healthy hold must never raise a payment prompt on Track');
}
assert.equal(canRecoverPaymentNow(active('completed')), false);
assert.equal(canRecoverPaymentNow(active('cancelled')), false);

// The case that widening was meant to catch — a row saying authorized while
// the Stripe hold has actually died — stays recoverable inside
// payment-recovery.js, which reads the live intent and can tell them apart.
const gateEscape = await readFile(new URL('../api/booking/payment-recovery.js', import.meta.url), 'utf8');
assert.match(gateEscape, /activeJobAlreadyAuthorized[\s\S]{0,200}payment_status === 'authorized'/,
  'the stale-authorized case must still be recoverable where the live intent is known');
assert.match(gateEscape, /!canRecoverPaymentNow\(booking\) && !activeJobAlreadyAuthorized/,
  'and must add to the shared gate, never replace it');

const guestToken = 'guest-management-token';
const paymentToken = 'payment-recovery-token';
const booking = {
  guest_mutation_token_hash: sha256(guestToken),
  payment_recovery_token_hash: sha256(paymentToken),
};
assert.equal(hasValidGuestPaymentToken(booking, guestToken), true);
assert.equal(hasValidGuestPaymentToken(booking, paymentToken), false);
assert.equal(hasValidPaymentRecoveryToken(booking, paymentToken), true);
assert.equal(hasValidPaymentRecoveryToken(booking, guestToken), false);

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [recovery, ownerSend, scheduled, confirmation, verifyCode, migration] = await Promise.all([
  read('api/booking/payment-recovery.js'),
  read('api/owner/send-payment-continuation.js'),
  read('api/cron/authorize-scheduled-payments.js'),
  read('api/booking-confirmed.js'),
  read('api/track/verify-code.js'),
  read('api/migrations/099_payment_recovery_token.sql'),
]);

assert.match(recovery, /payment_recovery_token_hash/);
assert.match(recovery, /intent\.status === 'canceled'[\s\S]*createReplacementIntent/);
assert.match(recovery, /capture_method: 'manual'/);
assert.doesNotMatch(recovery, /paymentIntents\.capture\(/);
assert.match(recovery, /financial_operation_type: 'payment_recovery_replacement'/);
assert.match(recovery, /cancelUnlinkedIntent/);
assert.match(recovery, /if \(intent\.status !== 'requires_capture' && intent\.status !== 'canceled'/,
  'the GET page must render for a canceled hold so POST can replace it');

assert.match(ownerSend, /payment_recovery_token_hash: nextGuestTokenHash/);
assert.doesNotMatch(ownerSend, /guest_mutation_token_hash: nextGuestTokenHash/);
assert.match(scheduled, /payment_recovery_token_hash: nextHash/);
assert.doesNotMatch(scheduled, /guest_mutation_token_hash: nextHash/);
assert.doesNotMatch(verifyCode, /payment_recovery_token_hash/,
  'Track code verification must not rotate payment recovery credentials');

assert.match(confirmation, /validRecoveryToken/);
assert.match(confirmation, /\['pending', 'failed', 'authorized'\]\.includes\(booking\.payment_status\)/);
assert.match(confirmation, /validGuestToken[\s\S]*guestTrackUrl/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS payment_recovery_token_hash/);

// The replacement must not inherit the dead hold's expiry. Migration 097 added
// that column; a stale value has the expiry monitor reporting a date that
// belongs to a PaymentIntent which no longer exists.
assert.match(recovery, /stripe_payment_intent_id: created\.id,[\s\S]{0,400}authorization_capture_before: null/,
  'a replaced hold must clear the deadline that described the dead one');

// The lock type has to be one the database permits, or the lock write fails
// the check constraint and no replacement is ever created.
const constraint = await read('api/migrations/098_payment_recovery_replacement_operation.sql');
assert.match(constraint, /'payment_recovery_replacement'/,
  'the operation type must be permitted by bookings_financial_operation_type_check');

// ── "The link expired" must mean the link expired ───────────────────────────
// A busy booking and a server fault are both momentary. Reporting either as a
// dead link is what had her requesting link after link, each one saying the
// same thing.
assert.match(recovery, /const temporary = status >= 500 \|\| status === 409/,
  'only 410 may be reported as a finished link');
assert.match(recovery, /This page is busy for a moment/,
  'a momentary conflict must read as momentary');
assert.doesNotMatch(recovery, /initializeError \? 503 : 410/,
  'a contended token write must not be reported as an expired link');

console.log('PASS payment link recovery: dead holds replace safely, active jobs stay active, tracking tokens are independent, and only a dead link says so');