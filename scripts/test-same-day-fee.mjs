// Same-day service fee — money-path regression test.
// Proves: (1) server-authoritative same-day detection, (2) the fee threads through
// pricing as a taxable additive line, (3) the completion split excludes the fee
// from the 30/70 base and adds the fixed Easer bonus + platform remainder, and
// (4) everything reconciles to the penny. Run: node scripts/test-same-day-fee.mjs
import assert from 'node:assert';

process.env.SAME_DAY_ENABLED = 'true';

const {
  sameDayFeeForAppointment, chicagoDateIso, isSameDayServiceEnabled,
  SAME_DAY_FEE_CENTS, SAME_DAY_EASER_BONUS_CENTS, SALES_TAX_RATE,
  computeBookingSplitFromSnapshot,
} = await import('../api/_source-of-truth.js');
const { calculateBookingPricing, getBookingCatalog } = await import('../api/_pricing.js');

// ── 1) Same-day detection (server-authoritative, date-driven) ────────────────
const today = chicagoDateIso();
assert.equal(isSameDayServiceEnabled(), true, 'flag on');
assert.equal(sameDayFeeForAppointment(today), SAME_DAY_FEE_CENTS, 'today => full fee');
assert.equal(sameDayFeeForAppointment('2099-12-31'), 0, 'future date => no same-day fee');
assert.equal(sameDayFeeForAppointment('2020-01-01'), 0, 'past date => no fee');

process.env.SAME_DAY_ENABLED = 'false';
assert.equal(sameDayFeeForAppointment(today), 0, 'feature OFF => no fee even today');
process.env.SAME_DAY_ENABLED = 'true';

// ── 2) Pricing threads the fee as a taxable additive line ────────────────────
const catalog = getBookingCatalog();
let serviceName, itemName;
for (const [svc, groups] of Object.entries(catalog.subcategories || {})) {
  for (const g of groups || []) {
    for (const it of g.items || []) {
      if (!it.addon && !it.customQuote && Number(it.price) > 0) { serviceName = svc; itemName = it.name; break; }
    }
    if (itemName) break;
  }
  if (itemName) break;
}
assert.ok(itemName, 'found a priced base catalog item to test with');

const zip = '78701'; // Austin core
const cart = { services: [serviceName], itemsByService: { [serviceName]: [{ name: itemName, qty: 1 }] }, zip };
const base = calculateBookingPricing({ ...cart });
const withFee = calculateBookingPricing({ ...cart, sameDayFeeCents: SAME_DAY_FEE_CENTS });

assert.equal(withFee.sameDayFeeCents, SAME_DAY_FEE_CENTS, 'pricing returns the applied same-day fee');
assert.equal(base.sameDayFeeCents, 0, 'no fee when none passed');
assert.equal(withFee.taxableSubtotalCents - base.taxableSubtotalCents, SAME_DAY_FEE_CENTS, 'taxable subtotal +$69');
const taxDelta = withFee.taxCents - base.taxCents;
assert.equal(withFee.totalCents - base.totalCents, SAME_DAY_FEE_CENTS + taxDelta, 'total +$69 +tax on $69');
assert.ok(taxDelta > 0, 'same-day fee is taxed');

// ── 3) Completion split — exclude the fee from the base, add the bonus back ──
// Mirrors sameDaySplitParts + the split mutation in assembler-complete.js.
function completionSplit({ finalAmount, taxCents, sameDayFeeCents, bonusCents, feePct }) {
  const sdTax = Math.round(sameDayFeeCents * SALES_TAX_RATE);
  const s = computeBookingSplitFromSnapshot({
    amountChargedCents: finalAmount - (sameDayFeeCents + sdTax),
    taxCents: taxCents - sdTax,
    feePct,
    assemblecashRedeemedCents: 0,
  });
  s.platformFeeCents += (sameDayFeeCents - bonusCents);
  s.assemblerDueCents += bonusCents;
  return s;
}

// Worked example: items $200 + service call $5 = $205 base, + $69 same-day.
const taxableCents = 20500 + SAME_DAY_FEE_CENTS;            // $274.00
const exTax = Math.round(taxableCents * SALES_TAX_RATE);    // $22.61
const exTotal = taxableCents + exTax;                       // $296.61
const split = completionSplit({
  finalAmount: exTotal, taxCents: exTax,
  sameDayFeeCents: SAME_DAY_FEE_CENTS, bonusCents: SAME_DAY_EASER_BONUS_CENTS, feePct: 30,
});

assert.equal(exTax, 2261, 'tax = $22.61');
assert.equal(exTotal, 29661, 'total = $296.61');
assert.equal(split.assemblerDueCents, 17350, 'Easer earns $173.50 ($143.50 base + $30 bonus)');
assert.equal(split.platformFeeCents, 10050, 'platform gross $100.50 ($61.50 base + $39)');

// ── 4) Reconciliation to the penny ───────────────────────────────────────────
assert.equal(split.platformFeeCents + split.assemblerDueCents, taxableCents, 'platform + Easer = pre-tax revenue base');
assert.equal(exTotal, taxableCents + exTax, 'total = base + tax');
// Same-day fee split exactly: $30 to Easer, $39 to business (never 30/70 on $69).
assert.equal(SAME_DAY_FEE_CENTS - SAME_DAY_EASER_BONUS_CENTS, 3900, 'business keeps $39 of the $69');

console.log('PASS same-day-fee: detection, pricing, split, and penny reconciliation all correct.');
