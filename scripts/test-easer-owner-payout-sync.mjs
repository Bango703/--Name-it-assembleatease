// Proves the Easer dashboard and the Owner dashboard NEVER disagree about a
// job's money. Both derive from the same loadLedgerFirstFinanceRows(); the Easer
// endpoint scopes it to their id and reshapes each row via toEaserEarningDto.
// This test runs the real functions over a mocked database across the full
// lifecycle (offline + online, before/after payout, uncollected, refunded) and
// asserts, per booking, that what the Easer sees == what the Owner sees.
import assert from 'node:assert/strict';
import { loadLedgerFirstFinanceRows, summarizeFinanceRows } from '../api/owner/_finance-ledger.js';
import { toEaserEarningDto, summarizeEaserEarnings } from '../api/assembler/_earnings.js';
import { computeBookingSplitFromSnapshot } from '../api/_source-of-truth.js';

process.env.EASER_MEMBERSHIP_ENABLED = 'false';
const EID = 'easer-1';
const NOW = '2026-07-17T12:00:00.000Z';

// Canonical earnings for a $110 all-in offline job and a $150 online job.
const offlineDue = computeBookingSplitFromSnapshot({ amountChargedCents: 11000, taxCents: 838, feePct: 30 }).assemblerDueCents; // 7113
const onlineDue = computeBookingSplitFromSnapshot({ amountChargedCents: 15000, taxCents: 1144, feePct: 30 }).assemblerDueCents;

// ── Mock Supabase: the exact query chains loadLedgerFirstFinanceRows uses ──────
function mockSb({ bookings, ledger }) {
  const build = (name) => {
    const filters = [];
    const b = {
      select: () => b,
      order: () => b,
      in(col, vals) { filters.push(['in', col, vals]); return b; },
      eq(col, val) { filters.push(['eq', col, val]); return b; },
      then(resolve) {
        const src = name === 'bookings' ? bookings : name === 'payout_ledger' ? ledger : [];
        const data = src.filter(row => filters.every(([op, col, v]) =>
          op === 'in' ? v.includes(row[col]) : row[col] === v));
        resolve({ data, error: null });
      },
    };
    return b;
  };
  return { from: build };
}

// ── Lifecycle bookings (owner_manual = offline, source online = Stripe) ────────
const base = (over) => ({
  ref: over.id, assembler_id: EID, assembler_name: 'Owner Easer', assembler_tier: 'starter',
  total_price: 11000, amount_charged: 11000, tax_amount: 838, stripe_fee: 0,
  assembler_due: offlineDue, payout_mode_snapshot: 'manual', payout_status: 'pending',
  payout_amount: null, paid_out_at: null, completed_at: NOW, date: '2026-07-17',
  payout_review_status: 'not_required', ...over,
});

const bookings = [
  // A: offline, Easer linked, collected, NOT yet paid → both see owed, ready
  base({ id: 'A', source: 'owner_manual', status: 'completed', payment_status: 'offline_recorded',
    payment_method: 'cash', payment_collected: true, payment_collected_at: NOW, payment_collected_by: 'owner' }),
  // B: offline, PAID (owner recorded payout → ledger row + booking columns synced)
  base({ id: 'B', source: 'owner_manual', status: 'completed', payment_status: 'offline_recorded',
    payment_method: 'cash', payment_collected: true, payment_collected_at: NOW, payment_collected_by: 'owner',
    payout_status: 'paid', payout_amount: offlineDue, paid_out_at: NOW }),
  // C: online, captured, assigned, NOT yet paid → both see owed, ready
  base({ id: 'C', source: 'online', status: 'completed', payment_status: 'captured',
    total_price: 15000, amount_charged: 15000, tax_amount: 1144, stripe_fee: 465, assembler_due: onlineDue }),
  // D: online, PAID via ledger
  base({ id: 'D', source: 'online', status: 'completed', payment_status: 'captured',
    total_price: 15000, amount_charged: 15000, tax_amount: 1144, stripe_fee: 465, assembler_due: onlineDue,
    payout_status: 'paid', payout_amount: onlineDue, paid_out_at: NOW }),
  // E: offline, work done but customer payment NOT recorded collected → HOLD on both
  base({ id: 'E', source: 'owner_manual', status: 'completed', payment_status: 'offline_recorded',
    payment_method: 'cash', payment_collected: false, payment_collected_at: null, payment_collected_by: null }),
  // F: online, refunded after completion, review not done → HOLD on both
  base({ id: 'F', source: 'online', status: 'completed', payment_status: 'refunded',
    refund_amount: 5000, payout_review_status: 'not_required' }),
];

// Ledger rows exist only for the paid jobs (B, D) — mirrors record_booking_payout.
const ledger = [
  { booking_id: 'B', payout_amount: offlineDue, platform_revenue: 3049, amount_charged: 11000, recorded_at: NOW },
  { booking_id: 'D', payout_amount: onlineDue, platform_revenue: 3806, amount_charged: 15000, recorded_at: NOW },
];

const sb = mockSb({ bookings, ledger });

// OWNER view = every finance row. EASER view = same function scoped to the id,
// then each row reshaped exactly as api/assembler/earnings.js does.
const ownerFinance = await loadLedgerFirstFinanceRows(sb, {});
const easerFinance = await loadLedgerFirstFinanceRows(sb, { assemblerId: EID });
const ownerByRef = new Map(ownerFinance.rows.map(r => [r.ref, r]));
const easerDtos = easerFinance.rows.filter(r => r.assemblerId === EID).map(toEaserEarningDto);
const easerByRef = new Map(easerDtos.map(d => [d.booking_ref, d]));

assert.equal(ownerFinance.rows.length, 6, 'owner sees all six finance rows');
assert.equal(easerDtos.length, 6, 'easer sees their six earnings');

// ── The core guarantee: per job, Easer number == Owner number, status agrees ──
const expect = {
  A: { amount: offlineDue, ownerPaid: false, easerDisposition: 'pending' },
  B: { amount: offlineDue, ownerPaid: true, easerDisposition: 'paid' },
  C: { amount: onlineDue, ownerPaid: false, easerDisposition: 'pending' },
  D: { amount: onlineDue, ownerPaid: true, easerDisposition: 'paid' },
  E: { amount: offlineDue, ownerPaid: false, easerDisposition: 'on_hold' },
  F: { amount: offlineDue, ownerPaid: false, easerDisposition: 'on_hold' },
};

for (const [ref, exp] of Object.entries(expect)) {
  const owner = ownerByRef.get(ref);
  const easer = easerByRef.get(ref);
  assert.ok(owner && easer, `${ref}: both dashboards have the job`);

  // 1. Same MONEY. The Easer's shown amount is the owner's owed/paid amount.
  const ownerAmount = owner.paidOut ? owner.payoutAmount : owner.owed;
  assert.equal(easer.amount_cents, ownerAmount, `${ref}: Easer amount must equal Owner amount`);
  assert.equal(easer.amount_cents, exp.amount, `${ref}: amount must be the canonical due`);

  // 2. Same PAID/UNPAID truth.
  const easerPaid = easer.payout.disposition === 'paid';
  assert.equal(easerPaid, exp.ownerPaid, `${ref}: Easer paid-state must match`);
  assert.equal(owner.paidOut, exp.ownerPaid, `${ref}: Owner paid-state must match`);
  assert.equal(easer.payout.disposition, exp.easerDisposition, `${ref}: Easer disposition`);

  // 3. Same HOLD reason when on hold (Easer sees a message for the owner's reason).
  if (exp.easerDisposition === 'on_hold') {
    assert.equal(owner.payoutDisposition, 'on_hold', `${ref}: owner also shows a hold`);
    assert.ok(owner.payoutHoldCodes.length > 0, `${ref}: owner has a hold code`);
    assert.ok(easer.payout.status_message && easer.payout.status_message.length > 0,
      `${ref}: Easer sees a hold message`);
  }
}

// ── Aggregate totals must reconcile between the two dashboards ─────────────────
const ownerSummary = summarizeFinanceRows(ownerFinance.rows);
const easerSummary = summarizeEaserEarnings(easerDtos);

// Owner's total paid out to this Easer == Easer's own paid total.
assert.equal(ownerSummary.totalPaidOut, easerSummary.paid_cents, 'paid totals must reconcile');
assert.equal(ownerSummary.totalPaidOut, offlineDue + onlineDue, 'paid = B + D');
// Owner's pending/held owed == Easer awaiting + on_hold.
assert.equal(
  ownerSummary.pendingPayouts,
  easerSummary.awaiting_payout_cents + easerSummary.on_hold_cents,
  'outstanding totals must reconcile',
);

// ── Desync SAFETY NET: a ledger-paid job whose booking columns went stale must
// be flagged, so the owner is warned instead of the two views silently drifting.
const staleSb = mockSb({
  bookings: [base({ id: 'S', source: 'online', status: 'completed', payment_status: 'captured',
    payout_status: 'pending', payout_amount: null, paid_out_at: null })], // booking says NOT paid...
  ledger: [{ booking_id: 'S', payout_amount: offlineDue, platform_revenue: 3049, amount_charged: 11000, recorded_at: NOW }], // ...ledger says paid
});
const staleFinance = await loadLedgerFirstFinanceRows(staleSb, {});
assert.ok(staleFinance.reconciliation.mismatchedCount > 0, 'a stale booking/ledger desync must be detected');
assert.ok(staleFinance.reconciliation.mismatchedRefs.includes('S'), 'the desynced ref must be surfaced to the owner');

console.log('Easer/Owner payout sync tests: PASS');
console.log(`  offline job due=$${(offlineDue / 100).toFixed(2)}  online job due=$${(onlineDue / 100).toFixed(2)}`);
console.log('  offline + online, unpaid/paid/uncollected/refunded — Easer view == Owner view at every step');
console.log('  desync between booking columns and ledger is detected, not silently shown');
