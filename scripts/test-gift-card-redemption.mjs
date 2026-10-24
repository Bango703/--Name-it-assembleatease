#!/usr/bin/env node
// Gift cards stage 2 (owner, 2026-10-24): a gift card pays part of a booking.
// It is money already collected, not a discount, so the job must come out the
// same to the cent as one paid entirely by card: tax, the Easer's pay and the
// platform's share. The card always keeps a hold big enough for the largest
// cancellation fee, every failure returns the credit, and every reader of the
// pay split carries the gift card amount.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sot = await import('../api/_source-of-truth.js');
const gc = await import('../api/_gift-cards.js');
const { checkoutSummary } = await import('../api/booking/_checkout.js');
const { customerPaymentSummary } = await import('../api/booking/_customer-payment-summary.js');
const { evaluateCancellationPolicy } = await import('../api/booking/_cancellation-policy-truth.js');
const { isReusableBookingRow } = await import('../api/booking/_duplicate-booking-guard.js');

// A real-looking job: $377.00 pre-tax ($372 items + $5 service call), 8.25% tax.
const PRETAX = 37700;
const TAX = Math.round(PRETAX * 0.0825);
const TOTAL = PRETAX + TAX;
const GIFT = 6000;
const MAX_FEE_PCT = Math.max(sot.CANCELLATION_POLICY.lateFeePct, sot.CANCELLATION_POLICY.imminentFeePct);

// ── The pay split is identical with and without a gift card ─────────────
for (const feePct of [30, 25]) {
  const card = sot.computeBookingSplitFromSnapshot({ totalPriceCents: TOTAL, taxCents: TAX, feePct });
  const gift = sot.computeBookingSplitFromSnapshot({ totalPriceCents: TOTAL - GIFT, taxCents: TAX, feePct, giftCardAppliedCents: GIFT });
  assert.equal(gift.assemblerDueCents, card.assemblerDueCents, `Easer pay is unchanged by a gift card (${feePct}%)`);
  assert.equal(gift.platformFeeCents, card.platformFeeCents, 'the platform share is unchanged');
  assert.equal(gift.taxCents, card.taxCents, 'tax stays the tax on the full price');
  assert.equal(gift.payoutBaseCents, card.payoutBaseCents);
  assert.equal(gift.totalCents, TOTAL - GIFT, 'totalCents stays what the card paid');
  assert.equal(gift.giftCardAppliedCents, GIFT);
}
{
  // Without the add-back the Easer would be underpaid: prove the test has teeth.
  const naive = sot.computeBookingSplitFromSnapshot({ totalPriceCents: TOTAL - GIFT, taxCents: TAX, feePct: 30 });
  const card = sot.computeBookingSplitFromSnapshot({ totalPriceCents: TOTAL, taxCents: TAX, feePct: 30 });
  assert.ok(naive.assemblerDueCents < card.assemblerDueCents);
  // A gift card that covers more than the pre-tax amount still leaves tax whole.
  const big = sot.computeBookingSplitFromSnapshot({ totalPriceCents: 3000, taxCents: TAX, feePct: 30, giftCardAppliedCents: TOTAL - 3000 });
  assert.equal(big.taxCents, TAX, 'tax is never capped at the card charge');
  assert.equal(big.assemblerDueCents, card.assemblerDueCents);
}

// ── The financial summary counts gift card money beside the card charge ──
{
  const card = sot.computeBookingFinancialSummary({ amountChargedCents: TOTAL, taxAmountCents: TAX, assemblerDueCents: 26390, stripeFeeCents: 1200 });
  const gift = sot.computeBookingFinancialSummary({ amountChargedCents: TOTAL - GIFT, taxAmountCents: TAX, assemblerDueCents: 26390, stripeFeeCents: 1200, giftCardAppliedCents: GIFT });
  assert.equal(gift.platformFeeCents, card.platformFeeCents, 'platform fee is the same');
  assert.equal(gift.taxCollectedCents, card.taxCollectedCents, 'tax liability is the same');
  assert.equal(gift.platformGrossCents, card.platformGrossCents);
  assert.equal(gift.netChargedCents, TOTAL - GIFT, 'net charged is still only what the card paid');
  const none = sot.computeBookingFinancialSummary({ amountChargedCents: 0, totalPriceCents: 0, taxAmountCents: 0, giftCardAppliedCents: GIFT });
  assert.equal(none.platformFeeCents, 0, 'an uncharged booking never turns gift card credit into revenue');
}

// ── The card keeps a hold big enough for the largest cancellation fee ────
{
  const cap = gc.maxGiftCardCents({ totalCents: TOTAL, serviceSubtotalCents: PRETAX - 500, maxCancellationFeePct: MAX_FEE_PCT });
  const largestFee = Math.ceil((PRETAX - 500) * MAX_FEE_PCT / 100);
  assert.equal(cap, TOTAL - largestFee);
  assert.equal(gc.maxGiftCardCents({ totalCents: 60, serviceSubtotalCents: 0, maxCancellationFeePct: 15 }), 10, "Stripe's 50-cent minimum stays on the card");
  assert.equal(gc.maxGiftCardCents({ totalCents: 40, serviceSubtotalCents: 0, maxCancellationFeePct: 15 }), 0);
  // The owner, customer and guest cancel all capture the fee from the card hold.
  for (const tier of ['late', 'imminent']) {
    const pct = sot.CANCELLATION_POLICY[`${tier}FeePct`];
    assert.ok(Math.round((PRETAX - 500) * pct / 100) <= TOTAL - cap, `the ${tier} fee fits in what stays on the card`);
  }
}

// ── The cancellation fee is figured on the full price ────────────────────
{
  const base = {
    id: 'b1', date: '2026-11-02', time: '10:00 AM', status: 'confirmed', reschedule_count: 0,
    assembler_id: 'e1', assembler_accepted_at: '2026-10-30T00:00:00Z', tax_amount: TAX, service_call_fee: 500,
  };
  const nowMs = Date.parse('2026-11-02T13:00:00Z');
  const card = evaluateCancellationPolicy({ ...base, total_price: TOTAL }, { nowMs });
  const gift = evaluateCancellationPolicy({ ...base, total_price: TOTAL - GIFT, gift_card_applied_cents: GIFT }, { nowMs });
  assert.ok(card.policy.feeCents > 0, 'the example is inside a fee window');
  assert.equal(gift.policy.feeCents, card.policy.feeCents, 'a gift card does not shrink the cancellation fee');
}

// ── What the customer reads adds up ──────────────────────────────────────
{
  const rows = customerPaymentSummary({ total_price: TOTAL - GIFT, tax_amount: TAX, service_call_fee: 500, payment_status: 'authorized', gift_card_applied_cents: GIFT, gift_card_last4: 'K7QP' });
  const plain = customerPaymentSummary({ total_price: TOTAL, tax_amount: TAX, service_call_fee: 500, payment_status: 'authorized' });
  assert.equal(rows.total_cents, TOTAL - GIFT);
  assert.equal(rows.rows[0].cents, plain.rows[0].cents, 'Service & items is the same with a gift card');
  assert.deepEqual(rows.rows.at(-1), { label: 'Gift card ending K7QP', cents: -GIFT, strong: false });
  assert.equal(rows.rows.reduce((sum, r) => sum + r.cents, 0), TOTAL - GIFT, 'the rows add up to the total');
  const preview = checkoutSummary({ itemSubtotalCents: 37200, serviceCallFeeCents: 500, taxCents: TAX, totalCents: TOTAL }, null, null, { appliedCents: GIFT, last4: 'K7QP' });
  assert.equal(preview.total_cents, TOTAL - GIFT);
  assert.equal(preview.rows.at(-1).label, 'Gift card ending K7QP');
  assert.equal(preview.rows.reduce((sum, r) => sum + r.cents, 0), TOTAL - GIFT);
}

// ── A retry lands on the same booking only with the same gift card ──────
{
  const row = { total_price: TOTAL - GIFT, gift_card_applied_cents: GIFT, gift_card_id: 'card-1', stripe_payment_intent_id: 'pi_1' };
  assert.equal(isReusableBookingRow(row, { amountCents: TOTAL, giftCardId: 'card-1' }), true);
  assert.equal(isReusableBookingRow(row, { amountCents: TOTAL, giftCardId: 'card-2' }), false, 'a different card never reuses it');
  assert.equal(isReusableBookingRow(row, { amountCents: TOTAL }), false, 'a retry without the card never lands on a gift card booking');
  assert.equal(isReusableBookingRow(row, { amountCents: TOTAL + 100, giftCardId: 'card-1' }), false, 'the full price must match');
  assert.equal(isReusableBookingRow({ total_price: TOTAL, stripe_payment_intent_id: 'pi_2' }, { amountCents: TOTAL }), true, 'card-only retries behave as before');
  assert.equal(isReusableBookingRow({ total_price: TOTAL, stripe_payment_intent_id: 'pi_2' }, { amountCents: TOTAL, giftCardId: 'card-1' }), false);
}

// ── Applying a card takes atomically and stays inside the cap ────────────
{
  const calls = [];
  const code = 'AAEG-K7QP-2MXR-9HTB';
  const card = { id: 'card-1', status: 'active', kind: 'move_in_pass', code_last4: '9HTB', priority_until: new Date(Date.now() + 86400000).toISOString() };
  const sb = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: card, error: null }) }) }) }),
    rpc: async (name, args) => { calls.push({ name, args }); return { data: [{ gift_card_id: 'card-1', paid_used: 4900, bonus_used: 1100 }], error: null }; },
  };
  const out = await gc.applyGiftCardToBooking(sb, { code, bookingRef: 'AAE-TEST000001', totalCents: TOTAL, serviceSubtotalCents: PRETAX - 500, maxCancellationFeePct: MAX_FEE_PCT });
  assert.equal(out.ok, true);
  assert.equal(out.appliedCents, 6000);
  assert.equal(out.priority, true, 'a Move-In Pass inside 30 days marks the booking priority');
  assert.equal(calls[0].name, 'gift_card_redeem_v1');
  assert.equal(calls[0].args.p_code_hash, gc.hashCode(code));
  assert.equal(calls[0].args.p_amount_cents, gc.maxGiftCardCents({ totalCents: TOTAL, serviceSubtotalCents: PRETAX - 500, maxCancellationFeePct: MAX_FEE_PCT }), 'it asks for no more than the cap');
  const voidSb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...card, status: 'void' }, error: null }) }) }) }), rpc: async () => { throw new Error('must not redeem a void card'); } };
  assert.equal((await gc.applyGiftCardToBooking(voidSb, { code, bookingRef: 'AAE-X', totalCents: TOTAL, serviceSubtotalCents: 1, maxCancellationFeePct: 15 })).code, 'GIFT_CARD_VOID');
  assert.equal((await gc.applyGiftCardToBooking(sb, { code: 'nope', bookingRef: 'AAE-X', totalCents: TOTAL, serviceSubtotalCents: 1, maxCancellationFeePct: 15 })).code, 'GIFT_CARD_INVALID');
}

// ── Every reader of the pay split carries the gift card ──────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'migrations') walk(full, out); }
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}
const apiFiles = walk(new URL('../api', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let splitCalls = 0;
for (const file of apiFiles) {
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const rel = file.replace(/\\/g, '/').split('/api/').pop();
  if (rel === '_source-of-truth.js') continue;
  for (const match of src.matchAll(/computeBookingSplitFromSnapshot\(\{([\s\S]*?)\}\)/g)) {
    splitCalls += 1;
    assert.match(match[1], /giftCardAppliedCents: \w+\.gift_card_applied_cents \|\| 0/, `api/${rel}: every split call passes the gift card amount`);
  }
  // A column list that loads AssembleCash for the split must load the gift card too.
  for (const match of src.matchAll(/'([^'\n]*assemblecash_redeemed_cents[^'\n]*)'/g)) {
    if (!match[1].includes(', ')) continue;
    assert.ok(match[1].includes('gift_card_applied_cents'), `api/${rel}: a booking column list with AssembleCash also selects gift_card_applied_cents`);
  }
}
assert.equal(splitCalls, 10, 'all ten split call sites were checked');

// ── Every way a booking fails, ends or expires returns the credit ────────
{
  const booking = read('api/booking.js');
  assert.match(booking, /giftCardCode,\n/, 'checkout reads the code');
  assert.match(booking, /\.\.\.\(giftCardAppliedCents > 0 \? \{\n\s+gift_card_applied_cents/, 'gift columns are written only when a card was used');
  for (const reason of ['booking_insert_failed', 'review_reward_failed', 'review_reward_unavailable', 'guest_token_setup_failed', 'stripe_setup_failed', 'legal_consent_schema_missing', 'gift_card_schema_missing']) {
    assert.match(booking, new RegExp(`releaseGiftCard\\('reverse:${reason}'\\)`), `a failed booking returns the credit (${reason})`);
  }
  assert.match(booking, /serviceSubtotalCents: amount - taxCents - serviceCallFeeCents/, 'the cap uses the same subtotal as the cancellation fee');
  assert.match(booking, /amount -= giftCardAppliedCents;/);
  assert.ok(/hasAssembleCash: !!assemblecashToken,\n\s+giftCardCode,/.test(booking), 'a retry passes the code so it reuses the same booking');
  assert.match(read('api/booking/_cancellation-credits.js'), /await releaseBookingGiftCard\(sb, booking,/, 'every cancellation returns the credit');
  assert.match(read('api/booking/decline.js'), /await releaseBookingGiftCard\(sb, booking, 'returned: booking declined'\)/);
  assert.match(read('api/cron/stale-booking.js'), /await releaseBookingGiftCard\(sb, b, 'returned: unpaid booking expired'\)/);
  assert.match(read('api/booking/_cancellation-policy-truth.js'), /\+ \(booking\.gift_card_applied_cents \|\| 0\)/);
  const cron = read('api/cron/gift-cards-reconcile.js');
  assert.match(cron, /A booking paid partly by gift card was refunded/, 'a refund on a gift card booking reaches the owner');
  assert.match(read('api/owner/gift-cards.js'), /action === 'return_booking_credit'/, 'the owner can return the credit from the dashboard');
  assert.doesNotMatch(read('api/assembler/stripe-webhook.js'), /gift_card|_gift-cards/, 'the Stripe webhook is untouched');
}

// ── Priority means offered to pros first ─────────────────────────────────
{
  const dispatch = read('api/cron/auto-dispatch.js');
  assert.match(dispatch, /gift_card_priority/);
  assert.match(dispatch, /Number\(b\.gift_card_priority === true\) - Number\(a\.gift_card_priority === true\)/, 'priority bookings are offered first');
  assert.match(read('gift-cards.html'), /bookings made with it are offered to our pros before other bookings/);
}

// ── The customer sees it before booking, and the Terms say it ────────────
{
  const book = read('book.html');
  assert.match(book, /id="s5-gc-box"[^>]*hidden/, 'the gift card field is hidden until codes are accepted');
  assert.match(book, /giftCardCode: \(BOOK\._giftCardsAccepting && !BOOK\._isQuoteFlow && BOOK\.giftCardCode\) \|\| ''/);
  assert.match(book, /Gift card ending ' \+ esc\(BOOK\._giftCard\.last4\)/);
  const terms = read('terms.html');
  assert.match(terms, /<h3>Gift Cards and the Move-In Pass<\/h3>/);
  assert.match(terms, /part of every booking stays on your card so a cancellation fee can apply/);
  assert.doesNotMatch(terms, /such as Setup Club or a Move-In Pass/);
  assert.match(read('privacy.html'), /<h3>Gift cards<\/h3>/, 'recipient names and emails are disclosed');
  assert.match(read('api/_legal-consent.js'), /CUSTOMER_TERMS_VERSION = '2026-10-24-gift-cards-v1'/);
  const migration = read('api/migrations/120_booking_gift_card.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS gift_card_applied_cents INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /bookings_gift_card_applied_nonnegative CHECK \(gift_card_applied_cents >= 0\)/);
}

console.log('gift card redemption: same Easer pay, tax and platform share to the cent; fee always fits on the card; every failure returns the credit');
