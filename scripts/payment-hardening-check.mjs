import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.GUEST_ACCESS_TOKEN_SECRET = 'test-only-payment-hardening-secret';
const {
  assertGuestTokenConfiguration,
  deriveGuestMutationToken,
  guestMutationTokenHash,
  safeTokenHashMatch,
} = await import('../api/_payment-security.js');
const { appointmentTimestampMs } = await import('../api/booking/_appt-date.js');

const booking = { id: '11111111-1111-4111-8111-111111111111', ref: 'AAE-TEST123', customer_email: 'customer@example.com' };
const token = deriveGuestMutationToken({ bookingId: booking.id, ref: booking.ref, email: booking.customer_email });
const hash = guestMutationTokenHash(booking);
assert.equal(safeTokenHashMatch(token, hash), true, 'valid guest mutation token must verify');
assert.equal(safeTokenHashMatch(token + 'x', hash), false, 'tampered guest mutation token must fail');
assert.notEqual(
  token,
  deriveGuestMutationToken({ bookingId: booking.id, ref: booking.ref, email: 'other@example.com' }),
  'token must be bound to booking identity',
);
assert.equal(
  new Date(appointmentTimestampMs('2026-07-13', '7:00 AM – 9:00 AM')).toISOString(),
  '2026-07-13T12:00:00.000Z',
  'Chicago appointment parser must accept an en-dash slot and apply CDT',
);

const savedGuestSecret = process.env.GUEST_ACCESS_TOKEN_SECRET;
const savedVercelEnv = process.env.VERCEL_ENV;
delete process.env.GUEST_ACCESS_TOKEN_SECRET;
process.env.VERCEL_ENV = 'production';
assert.throws(() => assertGuestTokenConfiguration(), /GUEST_ACCESS_TOKEN_SECRET/, 'production must require a dedicated guest token secret');
process.env.GUEST_ACCESS_TOKEN_SECRET = savedGuestSecret;
if (savedVercelEnv == null) delete process.env.VERCEL_ENV;
else process.env.VERCEL_ENV = savedVercelEnv;

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [bookingApi, confirmationApi, ownerConfirmApi, quoteApi, completeApi, assemblerCompleteApi, refundApi, payoutApi, webhookApi, migration] = await Promise.all([
  load('api/booking.js'),
  load('api/booking-confirmed.js'),
  load('api/booking/confirm.js'),
  load('api/owner/quote-approve.js'),
  load('api/booking/complete.js'),
  load('api/booking/assembler-complete.js'),
  load('api/booking/refund.js'),
  load('api/booking/payout.js'),
  load('api/assembler/stripe-webhook.js'),
  load('api/migrations/032_payment_truth_and_customer_consent.sql'),
]);

assert.match(bookingApi, /TAX_CONFIGURATION_REQUIRED/, 'production tax gate must fail closed');
assert.match(bookingApi, /GUEST_TOKEN_CONFIGURATION_REQUIRED/, 'production booking must require a dedicated guest token secret');
assert.match(bookingApi, /INVALID_SERVICE_HOURS/, 'server must enforce published booking hours');
assert.match(confirmationApi, /PAYMENT_BOOKING_MISMATCH/, 'confirmation must bind Stripe intent to booking');
assert.match(confirmationApi, /safeTokenHashMatch/, 'public confirmation must require the secure guest token');
assert.match(ownerConfirmApi, /ZERO_DOLLAR_CONFIRMATION_BLOCKED/, 'owner confirmation must block production zero-dollar bookings');
assert.match(ownerConfirmApi, /CUSTOMER_QUOTE_APPROVAL_REQUIRED/, 'owner confirmation must not bypass quote consent');
assert.match(quoteApi, /quote_token_hash/, 'quote approval must use one-time customer consent token');
assert.match(quoteApi, /customer_quote_approval/, 'customer approval must be recorded as confirmer');
assert.match(completeApi, /capturedRecovery/, 'owner completion must recover a Stripe-success/DB-failure capture');
assert.match(assemblerCompleteApi, /capturedRecovery/, 'Easer completion must recover a Stripe-success/DB-failure capture');
assert.doesNotMatch(assemblerCompleteApi, /assembler_accepted_at:\s*booking\.assembler_accepted_at\s*\|\|/, 'completion must not synthesize Easer acceptance');
assert.match(refundApi, /partially_refunded/, 'partial refunds must remain distinct from full refunds');
assert.match(refundApi, /priorRefundedCents > dbRefundedCents/, 'refund retry must reconcile before issuing money again');
assert.match(payoutApi, /PAYOUT_AMOUNT_MISMATCH/, 'browser payout override must be rejected');
assert.match(payoutApi, /Stripe Connect transfers cannot be recorded manually/, 'manual ledger must not impersonate Connect');
assert.match(webhookApi, /payment_intent\.succeeded/, 'supported PaymentIntent success event must drive capture sync');
assert.match(webhookApi, /Webhook processing failed and is retryable/, 'webhook processing failures must return retryable errors');
assert.match(migration, /payment_status NOT IN \('captured', 'partially_refunded'\)/, 'database payout RPC must enforce captured funds');
assert.match(migration, /p_payout_amount_cents IS DISTINCT FROM canonical_due_cents/, 'database payout RPC must enforce canonical amount');
assert.match(migration, /stripe_bank_payout_status/, 'Connect transfer and bank payout states must be separate');

console.log('payment-hardening-check: PASS');
