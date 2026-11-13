#!/usr/bin/env node
// Owner, 2026-11-12:
//  1. "receipt needs a revamp... look like a real receipt, black and white."
//  2. "when it comes to easer application form, its no refund."
// Holds: one receipt for both completion paths, black and white, whose numbers
// always agree with the amount charged; the fee terms are non-refundable for
// new payments, legacy payments keep their refund, and the apply page shows
// the server's words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const receipt = await import('../api/booking/_receipt.js');
const fee = await import('../api/_easer-application-fee.js');
let passed = 0;
const ok = (name, fn) => { fn(); passed++; };

// ── Receipt ──────────────────────────────────────────────────────────────────
const booking = { ref: 'AAE-RCPT01', service: 'Furniture Assembly', date: '2026-11-20', tax_amount: 1642, service_call_fee: 500, promo_discount_cents: 0, payment_method_type: 'card', stripe_payment_intent_id: 'pi_1' };
const lines = [{ name: 'Queen bed frame', quantity: 1, cents: 11900 }, { name: '+ Safety anchoring', quantity: 2, cents: 7500 }];

ok('items, fees and tax add up to the charge, so prices are shown', () => {
  const f = receipt.receiptFigures(booking, lines, 21542);
  assert.equal(f.itemized, true);
  assert.deepEqual([f.total, f.subtotal, f.tax], [21542, 19900, 1642]);
  const html = receipt.renderReceipt({ booking, lines, amountChargedCents: 21542, chargedAt: '2026-11-20T20:00:00Z' });
  for (const text of ['RECEIPT', 'AAE-RCPT01', 'Queen bed frame', '$119.00', 'Service call', '$5.00', 'Texas sales tax', '$16.42', 'TOTAL', '$215.42', 'Balance due', 'AssembleAtEase LLC']) {
    assert.ok(html.includes(text), `receipt shows ${text}`);
  }
});

ok('when the items do not add up to the charge, no item prices are printed', () => {
  const f = receipt.receiptFigures(booking, lines, 30000);
  assert.equal(f.itemized, false);
  const html = receipt.renderReceipt({ booking, lines, amountChargedCents: 30000 });
  assert.ok(html.includes('Queen bed frame') && !html.includes('$119.00'));
  assert.ok(html.includes('$300.00'), 'the total is what was charged');
});

ok('credits appear as payments and the total includes them', () => {
  const b = { ...booking, assemblecash_redeemed_cents: 1000, gift_card_applied_cents: 2000 };
  const f = receipt.receiptFigures(b, lines, 18542);
  assert.equal(f.total, 21542);
  assert.equal(f.itemized, true);
  const html = receipt.renderReceipt({ booking: b, lines, amountChargedCents: 18542 });
  assert.ok(html.includes('AssembleCash') && html.includes('Gift card') && html.includes('$185.42'));
});

ok('the receipt is black and white, monospace, and claims no Stripe receipt', () => {
  const html = receipt.renderReceipt({ booking, lines, amountChargedCents: 21542 });
  const colors = new Set((html.match(/#[0-9a-fA-F]{3,6}\b/g) || []).map(c => c.toLowerCase()));
  colors.forEach(c => assert.ok(['#000', '#000000', '#fff', '#ffffff'].includes(c), `off-palette colour ${c}`));
  assert.match(html, /Courier New/);
  assert.doesNotMatch(html, /Stripe receipt/i);
  assert.equal(receipt.renderReceipt({ booking, lines, amountChargedCents: 0 }), '', 'nothing charged, no receipt');
});

ok('both completion paths use the one receipt', () => {
  for (const p of ['api/booking/complete.js', 'api/booking/assembler-complete.js']) {
    const src = read(p);
    assert.match(src, /import \{ buildReceiptHtml \} from '\.\/_receipt\.js';/);
    assert.match(src, /const receiptBlock = await buildReceiptHtml\(sb, booking, \{ amountChargedCents: /);
    assert.doesNotMatch(src, /Payment Receipt<\/p>/, `${p} still builds its own receipt card`);
    assert.doesNotMatch(src, /A Stripe receipt has been sent separately/);
  }
});

// ── Non-refundable application fee ───────────────────────────────────────────
const at = new Date().toISOString();
const current = { status: 'succeeded', metadata: { applicationFeeConsent: 'true', applicationFeeConsentVersion: fee.EASER_APPLICATION_FEE_CONSENT_VERSION, applicationFeeConsentAt: at } };
const legacy = { status: 'succeeded', metadata: { applicationFeeConsent: 'true', applicationFeeConsentVersion: fee.EASER_APPLICATION_FEE_LEGACY_CONSENT_VERSION, applicationFeeConsentAt: at } };

ok('new payments are non-refundable; legacy payments keep their refund', () => {
  assert.match(fee.EASER_APPLICATION_FEE_CONSENT_VERSION, /nonrefundable/);
  assert.equal(fee.isNonRefundableApplicationFee(current), true);
  assert.equal(fee.isNonRefundableApplicationFee(legacy), false);
  assert.equal(fee.hasEaserApplicationFeeConsent(current), true);
  assert.equal(fee.hasEaserApplicationFeeConsent(legacy), true, 'a legacy paid application still validates');
  assert.equal(fee.needsCurrentFeeConsent({ ...legacy, status: 'requires_payment_method' }), true, 'an unpaid legacy payment is re-stamped');
  assert.equal(fee.needsCurrentFeeConsent(legacy), false, 'a paid legacy payment is never re-stamped');
  assert.equal(fee.easerApplicationFeeConsentMetadata().applicationFeeConsentVersion, fee.EASER_APPLICATION_FEE_CONSENT_VERSION);
  assert.match(fee.EASER_APPLICATION_FEE_TERMS, /non-refundable, including if your application is not approved/);
});

ok('rejection keeps the fee only for a non-refundable payment with no refund activity', () => {
  const src = read('api/assembler/update.js');
  assert.match(src, /feeRetained = isNonRefundableApplicationFee\(paymentIntent\)\n\s+&& refundedCents === 0 && pendingRefundCents === 0 && !refundId\n\s+&& !\(refundTruth\.refunds \|\| \[\]\)\.length;/);
  assert.match(src, /if \(!feeRetained && refundedCents < EASER_APPLICATION_FEE_CENTS\) \{/);
  assert.match(src, /refundConfirmed = !feeRetained;/);
  assert.match(src, /if \(!feeWaived && databaseClaimsPaid && !refundConfirmed && !feeRetained\) \{/);
  assert.match(src, /\.\.\.\(feeRetained \? \{ p_fee_retained: true \} : \{\}\),/);
  assert.match(src, /const feeBlock = feeWaived \|\| feeRetained/);
});

ok('the apply page states the server terms and promises no refund', () => {
  const page = read('assembler/apply.html');
  assert.doesNotMatch(page, /full application fee is returned/);
  assert.doesNotMatch(page, /acknowledge the refund terms/);
  assert.match(page, /applicationFee\.terms/);
  assert.match(page, /non-refundable, including if my application is not approved/);
  assert.match(read('api/assembler/application-fee-status.js'), /terms: EASER_APPLICATION_FEE_TERMS,/);
});

ok('migration 130 adds one optional parameter and keeps one function', () => {
  const sql = read('api/migrations/130_easer_application_fee_retained.sql');
  assert.match(sql, /p_fee_retained BOOLEAN DEFAULT FALSE/);
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.finalize_easer_application_decision\(\n\s+UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ\n\);/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.finalize_easer_application_decision\(\n\s+UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, BOOLEAN\n\) TO service_role;/);
  assert.match(sql, /Paid application rejection requires a completed aggregate Stripe refund/, 'legacy refund rule kept');
});

console.log(`PASS receipt and fee terms: ${passed} checks. One black-and-white receipt whose numbers match the charge; new application fees non-refundable, legacy fees refunded as promised; apply page shows the server's terms.`);
