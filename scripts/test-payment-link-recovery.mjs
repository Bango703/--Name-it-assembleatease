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
  assert.equal(canRecoverPaymentNow({ ...active(status), payment_status: 'authorized' }), true,
    'a stale local authorized state may hide a Stripe hold that has already been canceled');
}
assert.equal(canRecoverPaymentNow(active('completed')), false);
assert.equal(canRecoverPaymentNow(active('cancelled')), false);

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

console.log('PASS payment link recovery: dead holds replace safely, active jobs stay active, and tracking tokens are independent');