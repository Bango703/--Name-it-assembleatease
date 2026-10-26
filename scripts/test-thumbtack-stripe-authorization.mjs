import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isThumbtackLiveFlow, usesThumbtackStripePayment } from '../api/_owner-easer.js';
import { isThumbtackStripeRecoveryBooking } from '../api/booking/_pending-payment-recovery.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const legacyBooking = {
  source: 'owner_manual',
  external_platform: 'thumbtack',
  external_agreement_verified_at: '2026-10-25T12:00:00.000Z',
  payment_method: 'thumbtack',
  payment_status: 'offline_recorded',
};
const realEaser = { role: 'assembler', is_owner: false, is_demo_account: false };
assert.equal(isThumbtackLiveFlow(legacyBooking, realEaser), true, 'legacy external collection lane stays supported');
assert.equal(usesThumbtackStripePayment(legacyBooking), false, 'legacy Thumbtack external-payment records stay in the offline lane');

const stripeBooking = {
  source: 'owner_manual',
  external_platform: 'thumbtack',
  external_agreement_verified_at: legacyBooking.external_agreement_verified_at,
  payment_method: null,
  payment_status: 'pending',
  status: 'confirmed',
  stripe_payment_intent_id: 'pi_example',
};
assert.equal(isThumbtackLiveFlow({ ...stripeBooking, payment_status: 'authorized' }, realEaser), false,
  'Stripe authorized Thumbtack jobs must use regular capture flow, not offline completion');
assert.equal(isThumbtackStripeRecoveryBooking(stripeBooking), true,
  'confirmed Thumbtack bookings can use their token-protected AAE payment authorization page');
assert.equal(usesThumbtackStripePayment(stripeBooking), true, 'Stripe-linked Thumbtack bookings use standard finance and completion flows');
assert.equal(isThumbtackStripeRecoveryBooking({ ...stripeBooking, payment_status: 'authorized' }), false,
  'authorized jobs do not request a second hold');
assert.equal(isThumbtackStripeRecoveryBooking({ ...stripeBooking, status: 'in_progress' }), false,
  'unpaid Thumbtack jobs cannot start work through the recovery path');

const migration = read('../api/migrations/121_thumbtack_stripe_authorization.sql');
const createLink = read('../api/owner/create-thumbtack-payment-link.js');
const recovery = read('../api/booking/payment-recovery.js');
const confirmed = read('../api/booking-confirmed.js');
const webhook = read('../api/assembler/stripe-webhook.js');
const complete = read('../api/booking/assembler-complete.js');
const ownerComplete = read('../api/booking/complete.js');
const finance = read('../api/owner/_finance-ledger.js');
const tax = read('../api/owner/tax-report.js');
const ownerUi = read('../owner/index.html');

assert.match(migration, /payment_method IS NULL\s+AND stripe_payment_intent_id IS NOT NULL/);
assert.match(createLink, /verifyOwner\(req\)/);
assert.match(createLink, /capture_method:\s*'manual'/);
assert.match(createLink, /payment_method:\s*null/);
assert.match(createLink, /payment_status:\s*'pending'/);
assert.match(createLink, /Number\(booking\.total_price\)/);
assert.match(createLink, /if \(booking\.customer_email\)\s*\{\s*emailResult = await sendEmail\(/,
  'the secure authorization link is emailed when a customer email is on file');
assert.match(createLink, /No payment was collected/,
  'creating the authorization link must not charge the customer');
for (const status of ['confirmed', 'en_route', 'arrived', 'in_progress']) {
  assert.match(createLink, new RegExp(`'${status}'`), `authorization links allow ${status} bookings`);
}
assert.match(createLink, /THUMBTACK_AUTHORIZATION_BOOKING_STATUSES\.has/,
  'only the explicit eligible Thumbtack booking statuses may create an authorization link');
assert.match(recovery, /validateCustomerLegalConsent/);
assert.match(recovery, /tax_amount/);
assert.match(recovery, /Service subtotal/);
assert.match(recovery, /Sales tax/);
assert.match(recovery, /Total hold/);
assert.match(recovery, /charge this amount after the job is marked complete/i);
assert.match(confirmed, /paymentRecoveryToken/);
assert.match(confirmed, /thumbtackStripeFlow/);
assert.match(webhook, /existing\.external_platform !== 'thumbtack'/);
assert.match(complete, /captureOrRecoverBookingPayment/);
assert.match(complete, /PAYMENT_NOT_AUTHORIZED/);
assert.match(ownerComplete, /usesThumbtackStripePayment\(booking\)/);
assert.match(ownerComplete, /captureOrRecoverBookingPayment/);
assert.match(ownerComplete, /booking\.external_platform !== 'thumbtack'/);
assert.match(finance, /usesExternalStripePayment/);
assert.match(tax, /thumbtackStripePayment/);
assert.match(ownerUi, /Create Stripe Authorization Link/);
assert.match(ownerUi, /A secure email is sent if a customer email is on file; no Thumbtack message is sent/);

console.log('PASS: Thumbtack customer card hold, completion capture, and external Easer payout separation');
