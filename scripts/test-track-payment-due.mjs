#!/usr/bin/env node
// A customer who owes money can pay from the page they already have open.
//
// WHY. When a card failed, the only route back to payment was a secure link in
// an email. Lose the email, or never get it, and there was nothing on the
// tracking page to tell you money was owed or how to fix it — while the page
// happily showed the booking total as though everything were settled.
//
// The fix adds no new access. /api/booking/track already proves ownership with
// email + ref + the guest token, and /api/booking/payment-recovery gates on
// that same `guest_mutation_token_hash` through the same `safeTokenHashMatch`.
// The button simply hands the token the visitor already used to the page that
// already accepts it.
//
// The thing this file exists to stop: the page deciding for itself, from
// payment_status, whether payment is possible. That guess would drift from the
// recovery endpoint and offer a dead button — or hide a live one.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canRecoverPaymentNow, isStandardRecoveryBooking, hasValidGuestPaymentToken } from '../api/booking/_pending-payment-recovery.js';

const payableFixture = () => ({ status: 'confirmed', dispatch_status: 'payment_hold', payment_status: 'failed', stripe_payment_intent_id: 'pi_1' });

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

// ── 1. One predicate decides, and it is the recovery endpoint's own ─────────
const trackSrc = await read('api/booking/track.js');
assert.match(trackSrc, /payment_action_required: canRecoverPaymentNow\(booking\)/,
  'the flag must be the shared gate applied to the booking, not a hand-rolled condition');

// Three surfaces, one gate. If any of them stops asking the same question, a
// customer gets a button that 409s, or no button on a booking that owes money.
for (const file of ['api/booking/track.js', 'api/booking/payment-recovery.js', 'api/owner/send-payment-continuation.js']) {
  const src = await read(file);
  assert.match(src, /canRecoverPaymentNow/, `${file} must ask the shared gate`);
  assert.doesNotMatch(src, /isStandardRecoveryBooking/,
    `${file} must not call the underlying rule directly — widen the gate, not a caller`);
}
// And the gate must still answer for the states it covers today.
assert.equal(canRecoverPaymentNow(payableFixture()), true, 'the gate accepts a recoverable booking');
assert.equal(canRecoverPaymentNow({}), false, 'and refuses an empty one');

// ── 2. The predicate behaves ────────────────────────────────────────────────
const payable = payableFixture();
assert.equal(isStandardRecoveryBooking(payable), true, 'a confirmed booking with a failed hold can pay');
assert.equal(isStandardRecoveryBooking({ ...payable, payment_status: 'authorized' }), false,
  'an authorized booking owes nothing here — no button');
assert.equal(isStandardRecoveryBooking({ ...payable, stripe_payment_intent_id: null }), false,
  'with no payment intent there is nothing for the page to continue');
assert.equal(isStandardRecoveryBooking({}), false, 'an empty booking is not payable');

// ── 3. Both doors use the same key ──────────────────────────────────────────
// If these ever diverge, the tracking page would hand over a token the
// recovery page rejects, and the customer meets an error instead of a form.
for (const file of ['api/booking/track.js', 'api/booking/payment-recovery.js']) {
  assert.match(await read(file), /guest_mutation_token_hash/,
    `${file} must gate on the same stored token hash`);
}
assert.equal(hasValidGuestPaymentToken({ guest_mutation_token_hash: null }, 'anything'), false,
  'a booking with no stored token accepts nothing');

// ── 4. The page renders the server's verdict and nothing else ───────────────
const page = await read('track.html');
assert.ok(page.includes('id="payDueBox"'), 'the payment panel must exist');
assert.match(page, /if \(!b\.payment_action_required \|\| !currentMutationToken\)/,
  'the panel must be driven by the server flag and require a token');

// Everything below is asserted INSIDE the panel's own code. track.html is a
// big file and both of these strings appear elsewhere in it; matching the whole
// page let a broken panel pass.
const panelBlock = page.slice(page.indexOf("var box = document.getElementById('payDueBox')"),
  page.indexOf("box.style.display = '';"));
assert.ok(panelBlock.length > 100, 'the panel block was not found');
assert.match(panelBlock, /encodeURIComponent\(currentMutationToken\)/,
  'the link must carry the token this visitor already proved, never a fresh credential');
assert.match(panelBlock, /\/api\/booking\/payment-recovery\?bookingId=/,
  'the button must point at the secure page, not a new payment route');
// The panel must not re-derive payability from payment_status. That is the
// drift this whole file exists to prevent.
assert.doesNotMatch(panelBlock, /payment_status/,
  'the panel must not read payment_status — the server already decided');

// ── 5. The amount is printed once ───────────────────────────────────────────
// Booking Total $426.51 above and Amount Due $426.51 below reads as two
// charges. When the whole total is outstanding the panel relabels the figure
// already on the card; the second row appears only when part is genuinely paid.
assert.match(panelBlock, /partlyPaid/, 'the panel must distinguish a partial balance from the full total');
assert.match(panelBlock, /payDueRow'\)\.style\.display = 'none'/,
  'with the whole total outstanding the duplicate row must be hidden');
assert.match(panelBlock, /bPriceLabel'\)\.textContent = 'Amount due'/,
  'and the existing total must be relabelled instead');
assert.match(panelBlock, /formatUsdCents\(remaining\)/,
  'the second figure, when shown, is the remaining balance and not the total');

console.log('PASS track payment due: one predicate, one token, the page renders the verdict');
