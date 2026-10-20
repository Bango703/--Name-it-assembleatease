// Covers the three failures a declined card used to cause:
//   1. every payment retry created another pending booking
//   2. cancelling those duplicates emailed the customer once per duplicate,
//      about bookings they were never told existed
//   3. cancelled bookings kept a red "Needs manual assignment" alert
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  cartAllowsBookingReuse,
  classifyExistingIntent,
  isReusableBookingRow,
  UNPAID_BOOKING_REUSE_WINDOW_MS,
} from '../api/booking/_duplicate-booking-guard.js';

const failures = [];
function check(label, fn) {
  try { fn(); console.log('PASS ' + label); }
  catch (e) { failures.push(label + ': ' + e.message); console.log('FAIL ' + label); }
}

const AMOUNT = 32908; // the $329.08 booking from the duplicate report
const unpaidRow = {
  id: 'b1',
  ref: 'AAE-VIP2Z8YU18',
  total_price: AMOUNT,
  stripe_payment_intent_id: 'pi_declined',
  promo_code: null,
  assemblecash_redeemed_cents: 0,
};

// -- 1. A retry lands on the existing booking ------------------------------
check('a declined-card retry reuses the unpaid booking', () => {
  assert.equal(isReusableBookingRow(unpaidRow, { amountCents: AMOUNT }), true);
  assert.equal(
    classifyExistingIntent({ status: 'requires_payment_method', amount: AMOUNT, client_secret: 'cs_1' }, { amountCents: AMOUNT }),
    'reuse',
  );
});

check('an authorized card is never charged a second time', () => {
  for (const status of ['requires_capture', 'succeeded', 'processing']) {
    assert.equal(
      classifyExistingIntent({ status, amount: AMOUNT, client_secret: 'cs_1' }, { amountCents: AMOUNT }),
      'already_authorized',
      status,
    );
  }
});

check('a cart priced differently is never reused', () => {
  assert.equal(isReusableBookingRow({ ...unpaidRow, total_price: AMOUNT + 1000 }, { amountCents: AMOUNT }), false);
});

check('Stripe amount drift blocks reuse even when the row agrees', () => {
  assert.equal(
    classifyExistingIntent({ status: 'requires_payment_method', amount: AMOUNT + 500, client_secret: 'cs_1' }, { amountCents: AMOUNT }),
    'unusable',
  );
});

check('a cancelled or missing intent is not reused', () => {
  assert.equal(classifyExistingIntent({ status: 'canceled', amount: AMOUNT, client_secret: 'cs_1' }, { amountCents: AMOUNT }), 'unusable');
  assert.equal(
    classifyExistingIntent(
      { status: 'requires_payment_method', amount: AMOUNT, client_secret: 'cs_1', payment_method_types: ['klarna'] },
      { amountCents: AMOUNT, paymentMethodType: 'card' },
    ),
    'replace',
  );
  assert.equal(
    classifyExistingIntent(
      { status: 'requires_capture', amount: AMOUNT, client_secret: 'cs_1', payment_method_types: ['klarna'] },
      { amountCents: AMOUNT, paymentMethodType: 'card' },
    ),
    'already_authorized',
  );
  assert.equal(classifyExistingIntent(null, { amountCents: AMOUNT }), 'unusable');
  assert.equal(classifyExistingIntent({ status: 'requires_payment_method', amount: AMOUNT }, { amountCents: AMOUNT }), 'unusable');
});

check('rows holding a redemption are left alone', () => {
  assert.equal(isReusableBookingRow({ ...unpaidRow, promo_code: 'WELCOME10' }, { amountCents: AMOUNT }), false);
  assert.equal(isReusableBookingRow({ ...unpaidRow, assemblecash_redeemed_cents: 500 }, { amountCents: AMOUNT }), false);
  assert.equal(cartAllowsBookingReuse({ hasPromo: true, hasAssembleCash: false }), false);
  assert.equal(cartAllowsBookingReuse({ hasPromo: false, hasAssembleCash: true }), false);
  assert.equal(cartAllowsBookingReuse({ hasPromo: false, hasAssembleCash: false }), true);
});

check('a row with no intent attached is not reused', () => {
  assert.equal(isReusableBookingRow({ ...unpaidRow, stripe_payment_intent_id: null }, { amountCents: AMOUNT }), false);
});

check('the reuse window is bounded, not open-ended', () => {
  assert.ok(UNPAID_BOOKING_REUSE_WINDOW_MS > 0);
  assert.ok(UNPAID_BOOKING_REUSE_WINDOW_MS <= 24 * 60 * 60 * 1000);
});

// -- 2. Server wiring ------------------------------------------------------
const bookingApi = await readFile(new URL('../api/booking.js', import.meta.url), 'utf8');

check('the guard runs before the booking row is inserted', () => {
  const guardAt = bookingApi.indexOf('reuseUnpaidBooking(sb,');
  const insertAt = bookingApi.indexOf("sb.from('bookings').insert(activeBookingInsertPayload)");
  assert.ok(guardAt > 0 && insertAt > 0, 'both landmarks present');
  assert.ok(guardAt < insertAt, 'reuse check must precede the insert');
});

check('the guard runs before any AssembleCash is reserved', () => {
  const guardAt = bookingApi.indexOf('reuseUnpaidBooking(sb,');
  const reserveAt = bookingApi.indexOf('reserveRedemption(');
  assert.ok(reserveAt > 0, 'reservation landmark present');
  assert.ok(guardAt < reserveAt, 'reuse must not run after a redemption is held');
});

check('an already-authorized retry is refused rather than charged', () => {
  assert.ok(bookingApi.includes('BOOKING_ALREADY_AUTHORIZED'));
});

check('a failed dedupe lookup never blocks a booking', () => {
  assert.ok(/catch \(reuseErr\)/.test(bookingApi), 'reuse lookup is wrapped in its own catch');
});

// -- 3. The client stops re-POSTing on retry -------------------------------
const bookPage = await readFile(new URL('../book.html', import.meta.url), 'utf8');

check('the booking page reuses its PaymentIntent on a card retry', () => {
  assert.ok(bookPage.includes('orderFingerprint'), 'order fingerprint computed');
  assert.ok(bookPage.includes('BOOK._pendingPayment'), 'created booking is cached');
  assert.ok(/if \(reusablePayment\)/.test(bookPage), 'cached booking short-circuits the POST');
});

check('the cached booking is cleared once the booking is confirmed', () => {
  const confirmAt = bookPage.indexOf("sessionStorage.removeItem('aaePaymentRecovery')");
  const clearAt = bookPage.indexOf('BOOK._pendingPayment = null', confirmAt);
  assert.ok(confirmAt > 0 && clearAt > confirmAt, 'cleared alongside the recovery record');
});

check('the fingerprint covers everything that moves the price', () => {
  const block = bookPage.slice(bookPage.indexOf('var orderFingerprint'), bookPage.indexOf('var reusablePayment'));
  const fields = ['services', 'items', 'email', 'address', 'zip', 'date', 'time', 'totalCents', 'promoCode', 'assemblecashToken', 'bundleSlug', 'paymentMethod'];
  for (const field of fields) {
    assert.ok(block.includes(field + ':'), 'fingerprint includes ' + field);
  }
});

// -- 4. Cancelling an unannounced booking stays quiet ----------------------
const cancelApi = await readFile(new URL('../api/booking/cancel.js', import.meta.url), 'utf8');

check('no cancellation email for a booking the customer never saw', () => {
  assert.ok(cancelApi.includes('customerWasNeverNotified'));
  assert.ok(/if \(!suppressCancellationEmail\) try \{/.test(cancelApi), 'the send is gated');
});

check('money always overrides the silence', () => {
  const line = cancelApi.split('\n').find(l => l.includes('const suppressCancellationEmail'));
  assert.ok(line, 'suppression rule present');
  assert.ok(line.includes('refundAmount === 0'), 'a refund still emails');
  assert.ok(line.includes('feeCaptured === 0'), 'a captured fee still emails');
});

check('a confirmed booking still emails on cancellation', () => {
  assert.ok(cancelApi.includes('!booking.confirmed_at'), 'only unconfirmed bookings go quiet');
});

check('the skipped email is recorded on the timeline', () => {
  assert.ok(cancelApi.includes('cancellation_email_skipped'), 'owner can still see it happened');
});

// -- 5. Cancelled jobs stop asking for an Easer ----------------------------
check('cancelling clears the manual-dispatch flag', () => {
  const update = cancelApi.slice(cancelApi.indexOf('const cancellationUpdate = {'), cancelApi.indexOf('let updateQuery'));
  assert.ok(update.includes('needs_manual_dispatch: false'), 'flag cleared on cancel');
});

const ownerPage = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

check('the owner dashboard hides dispatch alerts on settled bookings', () => {
  assert.ok(ownerPage.includes('function isTerminalBooking'), 'helper exists');

  // Every place that paints the alert must sit behind a terminal-status check.
  // The condition and the markup are not always on the same line, so look back
  // from each occurrence of the label to the condition that guards it.
  const label = /Needs [Mm]anual [Aa]ssignment/g;
  let hit;
  let found = 0;
  while ((hit = label.exec(ownerPage))) {
    found++;
    const preceding = ownerPage.slice(Math.max(0, hit.index - 400), hit.index);
    assert.ok(
      preceding.includes('isTerminalBooking'),
      'ungated "Needs manual assignment" alert near index ' + hit.index,
    );
  }
  assert.equal(found, 2, 'both alert renders found');
});

check('terminal means cancelled, completed, declined, or refunded', () => {
  const fn = ownerPage.slice(ownerPage.indexOf('function isTerminalBooking'), ownerPage.indexOf('function bookingBadge'));
  for (const s of ['cancelled', 'completed', 'declined', 'refunded']) {
    assert.ok(fn.includes("'" + s + "'"), 'covers ' + s);
  }
});

// -- 6. Ages are readable, from one formatter -----------------------------
check('Live Ops does not print raw minutes', () => {
  assert.ok(!/\+age\+'min ago/.test(ownerPage), 'the raw-minutes template is gone');
  assert.ok(!/'min ago'/.test(ownerPage), 'no bare min-ago concatenation remains');
});

check('the dashboard has one relative-time formatter', () => {
  assert.ok(ownerPage.includes('function relativeAge('), 'shared helper exists');
  assert.ok(!ownerPage.includes('manualPaymentRelativeTime'), 'the single-caller name is retired');
  const calls = ownerPage.split('relativeAge(').length - 1;
  assert.ok(calls >= 3, 'helper is used by both call sites, saw ' + calls);
});

check('a missing timestamp reads as "recently", not 1970', () => {
  const fn = ownerPage.slice(ownerPage.indexOf('function relativeAge('), ownerPage.indexOf('function manualPaymentCardLabel'));
  assert.ok(/if \(!value\) return 'recently';/.test(fn), 'falsy timestamps are guarded');
  assert.ok(/time <= 0/.test(fn), 'epoch 0 is guarded');
});

const liveOps = await readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8');

check('Live Ops alerts age in the same shape the dashboard uses', () => {
  assert.ok(liveOps.includes('function formatAlertAge('), 'server helper exists');
  assert.ok(!/\/ 3600000\)\}h`/.test(liveOps), 'the raw-hours template is gone');
});

check('the alert age rolls over to days', () => {
  const fn = liveOps.slice(liveOps.indexOf('function formatAlertAge('), liveOps.indexOf('* GET /api/owner/live-ops'));
  assert.ok(fn.includes("'1 day'"), 'singular day');
  assert.ok(fn.includes('days}'), 'plural days');
  assert.ok(fn.includes('hours < 24'), 'hours only under a day');
});

// -- 7. Dispatch All cannot touch an unpaid booking ------------------------
const dispatchAll = await readFile(new URL('../api/owner/dispatch-all.js', import.meta.url), 'utf8');

check('Dispatch All only considers confirmed, payment-ready bookings', () => {
  // Asserts the EXCLUSIONS, not where they happen. The filters moved out of SQL
  // and into code so the sweep can report why each booking was skipped —
  // filtering in the query made "skipped" and "does not exist" indistinguishable,
  // and the owner got "Nothing to dispatch" while holding real work. The
  // guarantee is unchanged: these four categories never reach dispatchBooking.
  assert.ok(dispatchAll.includes("eq('status', 'confirmed')"), 'confirmed only');
  assert.ok(dispatchAll.includes("is('assembler_id', null)"), 'unassigned only');
  assert.ok(/needs_manual_dispatch/.test(dispatchAll), 'manual-assignment bookings are separated out');
  assert.ok(
    /!b\.needs_manual_dispatch/.test(dispatchAll),
    'candidates must exclude needs_manual_dispatch bookings',
  );
  assert.ok(
    /dispatch_paused !== true/.test(dispatchAll),
    'candidates must exclude dispatch-paused bookings',
  );
  assert.ok(
    /DISPATCH_PAYMENT_STATUSES\.includes\(b\.payment_status\)/.test(dispatchAll),
    'candidates must be in a dispatchable payment state',
  );
  assert.ok(dispatchAll.includes('isBookingPaymentReadyForDispatch'), 'second payment-truth filter');
  // Whatever is excluded must be COUNTED, so the owner is told what was skipped
  // and why rather than being shown a bare zero.
  assert.ok(/skipped/.test(dispatchAll), 'skipped bookings must be reported back to the owner');
});

const sourceOfTruth = await readFile(new URL('../api/_source-of-truth.js', import.meta.url), 'utf8');

check('a failed authorization is never a dispatch-eligible payment state', () => {
  const list = sourceOfTruth.slice(
    sourceOfTruth.indexOf('DISPATCH_PAYMENT_STATUSES = Object.freeze(['),
    sourceOfTruth.indexOf(']);', sourceOfTruth.indexOf('DISPATCH_PAYMENT_STATUSES = Object.freeze([')),
  );
  for (const unpaid of ['pending', 'failed', 'not_required', 'card_saved']) {
    assert.ok(!list.includes("'" + unpaid + "'"), unpaid + ' must not be dispatchable');
  }
});

console.log('');
if (failures.length) {
  console.log('Duplicate-booking and cancel-noise checks failed: ' + failures.length);
  for (const f of failures) console.log('- ' + f);
  process.exit(1);
}
console.log('Duplicate-booking and cancel-noise checks passed.');
