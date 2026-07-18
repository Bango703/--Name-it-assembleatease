// End-to-end lifecycle simulation. Walks ONE specific online job and ONE
// specific offline (owner-manual) job through EVERY state, calling the real
// business-logic functions the API uses, and printing exactly what happens to
// the booking and the money at each step — down to the Easer payout. Assertions
// fail loudly if any step is wrong. Run: node scripts/sim-full-lifecycle.mjs
import assert from 'node:assert/strict';
import {
  BOOKING_STATUS,
  computeBookingSplitFromSnapshot,
  computeBookingFinancialSummary,
  getPlatformFeePct,
  isActiveInstantBookingZip,
  isAutomaticDispatchZip,
  SALES_TAX_RATE,
} from '../api/_source-of-truth.js';
import { calculateBookingPricing, getBookingCatalog } from '../api/_pricing.js';
import { canTransitionBookingStatus } from '../api/booking/_workflow-engine.js';
import { buildEaserFeeSnapshot } from '../api/booking/_easer-fee-snapshot.js';
import { loadLedgerFirstFinanceRows, deriveManualPayoutReadiness } from '../api/owner/_finance-ledger.js';
import { toEaserEarningDto } from '../api/assembler/_earnings.js';
import { offlineMethodFeeCents } from '../api/owner/_offline-payment.js';

process.env.EASER_MEMBERSHIP_ENABLED = 'false';
const $ = (c) => '$' + (Number(c || 0) / 100).toFixed(2);
const line = () => console.log('─'.repeat(72));
let step = 0;
const S = (msg) => console.log(`\n[${++step}] ${msg}`);
const show = (b) => console.log(`      status=${b.status}  payment=${b.payment_status}` +
  `  charged=${$(b.amount_charged ?? b.total_price)}  tax=${$(b.tax_amount)}` +
  `  stripeFee=${b.stripe_fee == null ? 'null(est)' : $(b.stripe_fee)}` +
  `  easerDue=${b.assembler_due == null ? '—' : $(b.assembler_due)}` +
  `  payout=${b.payout_status || '—'}`);

// Mock DB so the real finance-ledger + Easer earnings run over our booking.
function mockSb({ bookings, ledger = [] }) {
  const build = (name) => {
    const filters = [];
    const b = {
      select: () => b, order: () => b,
      in(c, v) { filters.push(['in', c, v]); return b; },
      eq(c, v) { filters.push(['eq', c, v]); return b; },
      then(res) {
        const src = name === 'bookings' ? bookings : name === 'payout_ledger' ? ledger : [];
        res({ data: src.filter(r => filters.every(([o, c, v]) => o === 'in' ? v.includes(r[c]) : r[c] === v)), error: null });
      },
    };
    return b;
  };
  return { from: build };
}

const EID = 'easer-777';
const EASER = { id: EID, full_name: 'Travis (Owner-Easer)', has_membership: false, tier: 'starter' };

// Compare what the two dashboards show for a booking (+ optional ledger).
async function assertDashboardsAgree(booking, ledger, labelPaid) {
  const sb = mockSb({ bookings: [booking], ledger: ledger ? [ledger] : [] });
  const owner = (await loadLedgerFirstFinanceRows(sb, {})).rows[0];
  const easer = toEaserEarningDto((await loadLedgerFirstFinanceRows(sb, { assemblerId: EID })).rows[0]);
  const ownerAmt = owner.paidOut ? owner.payoutAmount : owner.owed;
  console.log(`      OWNER sees: ${$(ownerAmt)} ${owner.paidOut ? 'PAID' : owner.payoutDisposition.toUpperCase()}` +
    `   |   EASER sees: ${$(easer.amount_cents)} ${easer.payout.status_label}`);
  assert.equal(easer.amount_cents, ownerAmt, 'Easer amount must equal Owner amount');
  assert.equal(easer.payout.disposition === 'paid', owner.paidOut, 'paid-state must match');
  if (labelPaid != null) assert.equal(owner.paidOut, labelPaid, `expected paidOut=${labelPaid}`);
  return { owner, easer };
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║  JOB A — ONLINE booking (customer books on the website)          ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');

// Pick a REAL catalog item so pricing is authentic.
const catalog = getBookingCatalog();
let svcName, item;
for (const [service, groups] of Object.entries(catalog.subcategories || {})) {
  for (const g of groups) {
    const found = (g.items || []).find(i => !i.customQuote && Number(i.price) > 0);
    if (found) { svcName = service; item = found; break; }
  }
  if (item) break;
}
assert.ok(item, 'catalog must have a priced item');

S(`Customer picks: ${svcName} — "${item.name}" ($${item.price})  ·  ZIP 78701 (Austin)`);
const zipA = '78701';
console.log(`      isActiveInstantBookingZip(${zipA}) = ${isActiveInstantBookingZip(zipA)}  -> may book`);
console.log(`      isAutomaticDispatchZip(${zipA})    = ${isAutomaticDispatchZip(zipA)}  -> auto-dispatch to Easers`);
assert.equal(isActiveInstantBookingZip(zipA), true, 'Austin must be bookable');
assert.equal(isAutomaticDispatchZip(zipA), true, 'Austin must auto-dispatch');

S('Server prices the booking (calculateBookingPricing — server is source of truth)');
const pricing = calculateBookingPricing({ services: [svcName], itemsByService: { [svcName]: [{ name: item.name, quantity: 1 }] }, zip: zipA });
console.log(`      item subtotal=${$(pricing.itemSubtotalCents)}  service-call fee=${$(pricing.serviceCallFeeCents)}` +
  `  tax=${$(pricing.taxCents)}  TOTAL=${$(pricing.totalCents)}`);
assert.ok(pricing.totalCents > 0, 'must price to a positive total');

const A = {
  id: 'A', ref: 'AAE-ONLINE1', source: 'online',
  status: 'pending', payment_status: 'pending',
  total_price: pricing.totalCents, amount_charged: null, tax_amount: pricing.taxCents,
  stripe_fee: null, assembler_id: null, assembler_due: null,
  payout_status: null, payout_mode_snapshot: null, payout_review_status: 'not_required',
  date: '2026-07-20', payment_method: null,
};
S('Booking row created'); show(A);
assert.equal(A.status, 'pending'); assert.equal(A.payment_status, 'pending');

S('Stripe PaymentIntent created (capture_method: manual) — card AUTHORIZED, not charged');
A.payment_status = 'authorized'; A.stripe_payment_intent_id = 'pi_demo';
console.log('      webhook confirms the hold -> booking confirmed');
assert.ok(canTransitionBookingStatus(A.status, BOOKING_STATUS.CONFIRMED), 'pending->confirmed must be legal');
A.status = 'confirmed'; show(A);

S('Auto-dispatch: offer sent to top Easers; first to accept wins (atomic). Easer accepts.');
const snap = buildEaserFeeSnapshot(A, EASER, { snapshottedAt: '2026-07-20T09:00:00Z' });
A.assembler_id = EID; A.assembler_name = EASER.full_name; A.assembler_tier = 'starter';
Object.assign(A, snap.updates);
console.log(`      fee snapshot: feePct=${snap.feePct}%  estimated Easer earnings=${$(snap.estimatedDueCents)}`);
assert.equal(snap.feePct, 30, 'launch fee is 30%');

S('Easer works the job (each transition checked by canTransitionBookingStatus)');
for (const next of ['en_route', 'arrived', 'in_progress']) {
  const ok = canTransitionBookingStatus(A.status, next);
  console.log(`      ${A.status} -> ${next}: ${ok ? 'legal' : 'BLOCKED'}`);
  assert.ok(ok, `${A.status}->${next} must be legal`);
  A.status = next;
}

S('Easer marks COMPLETE -> Stripe captures the card -> money split computed');
const splitA = computeBookingSplitFromSnapshot({
  amountChargedCents: A.total_price, taxCents: A.tax_amount, feePct: snap.feePct,
});
assert.ok(canTransitionBookingStatus(A.status, BOOKING_STATUS.COMPLETED), 'in_progress->completed legal');
A.status = 'completed'; A.payment_status = 'captured';
A.amount_charged = splitA.totalCents; A.stripe_fee = 465; // actual Stripe fee from the capture
A.platform_fee_pct = splitA.feePct; A.platform_fee = splitA.platformFeeCents;
A.assembler_due = splitA.assemblerDueCents;
A.payout_status = 'pending'; A.payout_mode_snapshot = 'manual';
show(A);
console.log(`      SPLIT: charged=${$(splitA.totalCents)}  −tax=${$(splitA.taxCents)}  −platformFee(${splitA.feePct}%)=${$(splitA.platformFeeCents)}  = Easer earns ${$(splitA.assemblerDueCents)}`);
assert.equal(splitA.platformFeeCents + splitA.assemblerDueCents, splitA.pretaxCollectedCents, 'fee + easer = pre-tax base');

S('DASHBOARDS after completion (before payout) — Easer vs Owner must match');
await assertDashboardsAgree(A, null, false);

S('Owner records the Easer payout (payout.js -> record_booking_payout RPC)');
const readyA = deriveManualPayoutReadiness(A, { owed: A.assembler_due, hasCurrentCompletionEvidence: true });
console.log(`      payout readiness: ${readyA.disposition}${readyA.holdReasons.length ? ' — ' + readyA.holdReasons.join('; ') : ''}`);
assert.equal(readyA.disposition, 'pending', 'a captured completed job must be payable');
const ledgerA = { booking_id: 'A', payout_amount: A.assembler_due, platform_revenue: A.platform_fee, amount_charged: A.amount_charged, recorded_at: '2026-07-20T18:00:00Z' };
A.payout_status = 'paid'; A.payout_amount = A.assembler_due; A.paid_out_at = ledgerA.recorded_at;
console.log(`      ledger row written + booking updated: payout_status=paid, paid_out_at set`);

S('Money leaves the company to the Easer (manual ACH/Zelle — recorded in the ledger)');
console.log(`      Easer receives ${$(A.assembler_due)} by their chosen payout method`);

S('DASHBOARDS after payout — must both show PAID, same amount');
await assertDashboardsAgree(A, ledgerA, true);

const finA = computeBookingFinancialSummary({ amountChargedCents: A.amount_charged, taxAmountCents: A.tax_amount, stripeFeeCents: A.stripe_fee, assemblerDueCents: A.assembler_due, payoutAmountCents: A.payout_amount });
line();
console.log(`ONLINE JOB FINAL:  customer paid ${$(A.amount_charged)}  |  tax ${$(finA.taxCollectedCents)}  |  Stripe fee ${$(finA.processingFeeCents)}  |  Easer paid ${$(A.assembler_due)}  |  platform keeps ${$(finA.platformGrossCents)}`);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║  JOB B — OFFLINE booking (owner creates a manual job)           ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
step = 0;

S('Owner creates: King Bed Frame Assembly · Gupta · Georgetown 78642 · $139 -> $110 price match · CASH');
const zipB = '78642';
console.log(`      isActiveInstantBookingZip(${zipB}) = ${isActiveInstantBookingZip(zipB)}  (bookable)`);
console.log(`      isAutomaticDispatchZip(${zipB})    = ${isAutomaticDispatchZip(zipB)}  -> NOT auto-dispatched; owner-assigned only`);
assert.equal(isAutomaticDispatchZip(zipB), false, 'offline job must never auto-dispatch to all Easers');

S('Tax-inclusive split of the all-in $110 price (create-booking.js)');
const finalCents = 11000;
const subtotalCents = Math.round(finalCents / (1 + SALES_TAX_RATE));
const taxCentsB = finalCents - subtotalCents;
console.log(`      all-in ${$(finalCents)} = subtotal ${$(subtotalCents)} + Texas tax ${$(taxCentsB)} (${(SALES_TAX_RATE * 100).toFixed(2)}%)`);
assert.equal(subtotalCents + taxCentsB, finalCents, 'subtotal + tax must equal the all-in price');

const method = 'cash';
const B = {
  id: 'B', ref: 'AAE-GUPTA1', source: 'owner_manual',
  status: 'completed', payment_status: 'offline_recorded',
  total_price: finalCents, amount_charged: finalCents, tax_amount: taxCentsB,
  stripe_fee: offlineMethodFeeCents(method, finalCents),
  payment_method: method, payment_collected: true, payment_collected_at: '2026-07-17T15:00:00Z', payment_collected_by: 'owner',
  assembler_id: null, assembler_due: null, payout_status: null, payout_mode_snapshot: null,
  payout_review_status: 'not_required', date: '2026-07-17',
};
S('Booking row created (already completed, cash collected on site)'); show(B);
console.log(`      cash processing fee = ${$(B.stripe_fee)} (no card processor)`);
assert.equal(B.stripe_fee, 0, 'cash must carry no processing fee');

S('Owner links THEIR Easer account to the finished job (assign.js record-only link)');
const splitB = computeBookingSplitFromSnapshot({ amountChargedCents: B.amount_charged, taxCents: B.tax_amount, feePct: getPlatformFeePct(false) });
B.assembler_id = EID; B.assembler_name = EASER.full_name; B.assembler_tier = 'starter';
B.assembler_due = splitB.assemblerDueCents; B.platform_fee = splitB.platformFeeCents; B.platform_fee_pct = splitB.feePct;
B.payout_status = 'pending'; B.payout_mode_snapshot = 'manual';
B.stripe_fee = offlineMethodFeeCents(method, splitB.totalCents);
show(B);
console.log(`      SPLIT: charged=${$(splitB.totalCents)}  −tax=${$(splitB.taxCents)}  −platformFee(${splitB.feePct}%)=${$(splitB.platformFeeCents)}  = Easer earns ${$(splitB.assemblerDueCents)}`);

S('DASHBOARDS after link (before payout) — Easer vs Owner must match');
await assertDashboardsAgree(B, null, false);

S('Owner records the Easer payout — offline path requires migration 041');
const readyB = deriveManualPayoutReadiness(B, { owed: B.assembler_due, hasCurrentCompletionEvidence: true });
console.log(`      payout readiness: ${readyB.disposition}${readyB.holdReasons.length ? ' — ' + readyB.holdReasons.join('; ') : ''}`);
assert.equal(readyB.disposition, 'pending', 'offline collected job must be payable (needs 041 live in DB)');
const ledgerB = { booking_id: 'B', payout_amount: B.assembler_due, platform_revenue: B.platform_fee, amount_charged: B.amount_charged, recorded_at: '2026-07-17T18:00:00Z' };
B.payout_status = 'paid'; B.payout_amount = B.assembler_due; B.paid_out_at = ledgerB.recorded_at;

S('Money leaves the company to the Easer (manual — recorded)');
console.log(`      Easer receives ${$(B.assembler_due)}`);

S('DASHBOARDS after payout — both PAID, same amount');
await assertDashboardsAgree(B, ledgerB, true);

const finB = computeBookingFinancialSummary({ amountChargedCents: B.amount_charged, taxAmountCents: B.tax_amount, stripeFeeCents: B.stripe_fee, assemblerDueCents: B.assembler_due, payoutAmountCents: B.payout_amount });
line();
console.log(`OFFLINE JOB FINAL:  customer paid ${$(B.amount_charged)}  |  tax ${$(finB.taxCollectedCents)}  |  processing fee ${$(finB.processingFeeCents)}  |  Easer paid ${$(B.assembler_due)}  |  platform keeps ${$(finB.platformGrossCents)}`);

line();
console.log('\n✅ ALL STEPS PASSED — online and offline, start to finish, Easer paid, dashboards in sync.\n');
