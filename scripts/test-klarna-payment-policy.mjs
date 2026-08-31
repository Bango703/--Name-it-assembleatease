import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BOOKING_PAYMENT_METHOD,
  getKlarnaEligibility,
  normalizeBookingPaymentMethod,
} from '../api/booking/_payment-method.js';
import { changeOrderEligibility } from '../api/booking/_change-orders.js';
import { processBookingReauthorization } from '../api/cron/reauth-payments.js';

assert.equal(normalizeBookingPaymentMethod(), BOOKING_PAYMENT_METHOD.CARD);
assert.equal(normalizeBookingPaymentMethod(' KLARNA '), BOOKING_PAYMENT_METHOD.KLARNA);
assert.equal(normalizeBookingPaymentMethod('cash'), null);

assert.deepEqual(
  getKlarnaEligibility({ enabled: true, amountCents: 31_900 }),
  { eligible: true, reason: null },
);
assert.equal(getKlarnaEligibility({ enabled: false, amountCents: 31_900 }).reason, 'disabled');
assert.equal(getKlarnaEligibility({ enabled: true, quoteRequested: true, amountCents: 31_900 }).reason, 'custom_quote');
assert.equal(getKlarnaEligibility({ enabled: true, scheduledAuthorization: true, amountCents: 31_900 }).reason, 'future_booking');
assert.equal(getKlarnaEligibility({ enabled: true, accountMode: 'business', amountCents: 31_900 }).reason, 'business_booking');
assert.equal(getKlarnaEligibility({ enabled: true, amountCents: 0 }).reason, 'invalid_amount');

const liveBooking = {
  status: 'confirmed',
  stripe_customer_id: 'cus_test',
  stripe_payment_method_id: 'pm_test',
  financial_operation_key: null,
  financial_operation_type: null,
  financial_operation_started_at: null,
  stripe_dispute_id: null,
};
assert.equal(changeOrderEligibility({ ...liveBooking, payment_method_type: 'card' }).ok, true);
assert.match(
  changeOrderEligibility({ ...liveBooking, payment_method_type: 'klarna' }).reason,
  /separate card booking/i,
);

assert.deepEqual(
  await processBookingReauthorization({ booking: { id: 'booking-klarna', payment_method_type: 'klarna' } }),
  {
    ok: true,
    changed: false,
    recovered: false,
    skipped: true,
    reason: 'klarna_authorization_valid_28_days',
  },
);

const bookingApi = await readFile(new URL('../api/booking.js', import.meta.url), 'utf8');
const bookingPage = await readFile(new URL('../book.html', import.meta.url), 'utf8');
const bookingConfig = await readFile(new URL('../api/booking-config.js', import.meta.url), 'utf8');
const paymentIntentBuilder = bookingApi.slice(
  bookingApi.indexOf('function buildBookingPaymentIntentParams'),
  bookingApi.indexOf('function cleanText'),
);

assert.ok(paymentIntentBuilder.includes('payment_method_types: [paymentMethodType]'));
assert.ok(paymentIntentBuilder.includes("paymentMethodType === BOOKING_PAYMENT_METHOD.CARD"));
assert.ok(paymentIntentBuilder.includes("setup_future_usage: 'off_session'"));
assert.ok(paymentIntentBuilder.includes('...(cardPayment ? {'));
assert.ok(bookingPage.includes("paymentMethod: 'card'"), 'card remains the checkout default');
assert.ok(bookingPage.includes('Klarna available at checkout'), 'booking start announces Klarna availability');
assert.ok(bookingPage.includes('klarna-eligibility-note'), 'checkout explains method eligibility');
assert.ok(bookingPage.includes('appointments within six days'), 'future appointment limitation is stated clearly');
assert.ok(bookingPage.includes('paymentMethod: BOOK.paymentMethod'), 'selected method is sent to the server');
assert.ok(bookingPage.includes('confirmKlarnaPayment'), 'Klarna uses Stripe redirect confirmation');
assert.ok(bookingPage.includes("'/api/booking-confirmed'"), 'redirect recovery verifies the booking server-side');
assert.ok(bookingConfig.includes('isKlarnaEnabled()'), 'Klarna visibility is environment gated');

console.log('Klarna payment policy checks passed.');
