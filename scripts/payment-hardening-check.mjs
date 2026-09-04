import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.GUEST_ACCESS_TOKEN_SECRET = 'test-only-payment-hardening-secret';
const {
  assertGuestTokenConfiguration,
  deriveGuestMutationToken,
  guestMutationTokenHash,
  safeTokenHashMatch,
} = await import('../api/_payment-security.js');
const { appointmentTimestampMs, chicagoTodayIso, parseIsoCalendarDate } = await import('../api/booking/_appt-date.js');
const { getPayoutTransferIds } = await import('../api/assembler/stripe-webhook.js');
const { isRecoverableConnectAccountError } = await import('../api/_stripe-connect.js');

assert.equal(
  isRecoverableConnectAccountError({
    type: 'StripePermissionError',
    message: "The provided key does not have access to account 'acct_stale' (or that account does not exist). Application access may have been revoked.",
  }),
  true,
  'revoked or inaccessible Connect accounts must reset stale payout state',
);
assert.equal(
  isRecoverableConnectAccountError({ type: 'StripePermissionError', message: 'This API key cannot perform this action.' }),
  false,
  'unrelated Stripe permission errors must not erase Connect state',
);

const payoutListCalls = [];
const payoutTransferIds = await getPayoutTransferIds({
  balanceTransactions: {
    list(params, options) {
      payoutListCalls.push({ params, options });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'transfer', source: 'tr_included_1' };
          yield { type: 'charge', source: 'ch_unrelated' };
          yield { type: 'transfer', source: { id: 'tr_included_2' } };
          yield { type: 'transfer', source: 'tr_included_1' };
          // How a platform transfer ACTUALLY appears on the destination
          // account: type 'payment', source is a charge, and only the expanded
          // charge carries source_transfer. Matching 'transfer'/tr_ alone found
          // nothing on every real payout, so payout.paid was ignored every time
          // and no Easer was ever marked paid.
          yield { type: 'payment', source: { id: 'py_1', source_transfer: 'tr_included_3' } };
          // The payout's own debit line must never be mistaken for earnings.
          yield { type: 'payout', source: { id: 'po_test' } };
        },
      };
    },
  },
}, 'po_test', 'acct_test');
assert.deepEqual(payoutListCalls, [{
  // expand is REQUIRED: without it source is a bare string and source_transfer
  // is unreachable, which is exactly how the linkage silently returned [].
  params: { payout: 'po_test', limit: 100, expand: ['data.source'] },
  options: { stripeAccount: 'acct_test' },
}]);
assert.deepEqual(payoutTransferIds, ['tr_included_1', 'tr_included_2', 'tr_included_3']);

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
assert.equal(appointmentTimestampMs('2026-02-31', '7:00 AM – 9:00 AM'), null, 'invalid calendar dates must not roll into another day');
assert.equal(parseIsoCalendarDate('2026-02-31'), null);
assert.equal(chicagoTodayIso(new Date('2026-07-14T02:00:00.000Z')), '2026-07-13', 'booking windows must follow Austin date, not UTC date');

const savedGuestSecret = process.env.GUEST_ACCESS_TOKEN_SECRET;
const savedVercelEnv = process.env.VERCEL_ENV;
delete process.env.GUEST_ACCESS_TOKEN_SECRET;
process.env.VERCEL_ENV = 'production';
assert.throws(() => assertGuestTokenConfiguration(), /GUEST_ACCESS_TOKEN_SECRET/, 'production must require a dedicated guest token secret');
process.env.GUEST_ACCESS_TOKEN_SECRET = savedGuestSecret;
if (savedVercelEnv == null) delete process.env.VERCEL_ENV;
else process.env.VERCEL_ENV = savedVercelEnv;

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [bookingApi, confirmationApi, ownerConfirmApi, quoteApi, completeApi, assemblerCompleteApi, refundApi, payoutApi, webhookApi, migration, announcementSecurityMigration] = await Promise.all([
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
  load('api/migrations/058_easer_announcements_security.sql'),
]);

// The launch tax-approval gate was intentionally removed (owner decision) so
// every payment processes. Tax must still be calculated and recorded on every
// booking — that invariant stays; only the block is gone.
assert.match(bookingApi, /tax_amount: taxCents/, 'every booking must still record the calculated Texas sales tax');
assert.doesNotMatch(bookingApi, /TAX_CONFIGURATION_REQUIRED/, 'the launch tax-approval block must not re-block paid bookings');
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
assert.match(payoutApi, /booking\.payout_mode_snapshot !== 'manual'/, 'manual ledger must follow the earning snapshot, not the current Connect flag');
assert.match(payoutApi, /This earning was assigned to Stripe Connect and cannot be recorded as a manual payout/, 'manual ledger must not impersonate Connect');
assert.match(webhookApi, /payment_intent\.succeeded/, 'supported PaymentIntent success event must drive capture sync');
assert.match(webhookApi, /Webhook processing failed and is retryable/, 'webhook processing failures must return retryable errors');
assert.match(webhookApi, /balanceTransactions\.list\(\s*\{ payout: payoutId/, 'Connect bank payout reconciliation must load Stripe payout membership');
assert.match(webhookApi, /\.in\('stripe_transfer_id', transferIds\)/, 'Connect bank payout updates must target exact Stripe transfer IDs');
assert.match(webhookApi, /\.in\('stripe_bank_payout_status', \['pending', 'failed'\]\)/, 'a later successful bank payout must recover an earlier failed payout state');
// Tied to the number of Connect payout cases rather than a fixed count, so
// adding a case WITHOUT the flag gate fails instead of merely moving the number.
const connectGateCount = (webhookApi.match(/if \(!isStripeConnectEnabled\(\)\)/g) || []).length;
const connectIgnoreCount = (webhookApi.match(/reason: 'stripe_connect_disabled'/g) || []).length;
const payoutCaseCount = (webhookApi.match(/case 'payout\.[a-z]+':/g) || []).length;
assert.ok(payoutCaseCount >= 3, `expected the payout.* Connect cases, found ${payoutCaseCount}`);
assert.ok(connectGateCount >= payoutCaseCount,
  `every Connect payout case must be dormant while the flag is disabled; ${payoutCaseCount} case(s) but ${connectGateCount} gate(s)`);
assert.equal(connectIgnoreCount, connectGateCount,
  'every disabled Connect event must be explicitly audited as ignored, not silently dropped');
// And prove it per case, not just by count.
for (const m of webhookApi.matchAll(/case 'payout\.[a-z]+':([\s\S]*?)(?=\n {6}case '|\n {6}default:)/g)) {
  assert.match(m[1], /if \(!isStripeConnectEnabled\(\)\)/,
    `Connect payout case ${m[0].slice(0, 24)} must be gated by the feature flag`);
}
assert.doesNotMatch(webhookApi, /\.lte\('stripe_transfer_created_at'/, 'Connect bank payouts must not mark earnings paid by timestamp');
assert.match(migration, /payment_status NOT IN \('captured', 'partially_refunded'\)/, 'database payout RPC must enforce captured funds');
assert.match(migration, /p_payout_amount_cents IS DISTINCT FROM canonical_due_cents/, 'database payout RPC must enforce canonical amount');
assert.match(migration, /stripe_bank_payout_status/, 'Connect transfer and bank payout states must be separate');
assert.match(announcementSecurityMigration, /ALTER TABLE public\.easer_announcements ENABLE ROW LEVEL SECURITY/, 'announcement configuration must enforce RLS');
assert.match(announcementSecurityMigration, /ALTER TABLE public\.easer_announcement_deliveries ENABLE ROW LEVEL SECURITY/, 'announcement delivery state must enforce RLS');
assert.match(announcementSecurityMigration, /REVOKE ALL ON TABLE public\.easer_announcements FROM PUBLIC, anon, authenticated/, 'announcement configuration must not be publicly accessible');
assert.match(announcementSecurityMigration, /REVOKE ALL ON TABLE public\.easer_announcement_deliveries FROM PUBLIC, anon, authenticated/, 'announcement delivery state must not be publicly accessible');

console.log('payment-hardening-check: PASS');
