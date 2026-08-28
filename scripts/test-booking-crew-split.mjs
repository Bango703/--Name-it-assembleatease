#!/usr/bin/env node

/**
 * Locks the money behaviour of multi-Easer jobs.
 *
 * The whole risk of putting two people on one booking is that the platform pays
 * out more than it collected, or silently pays one of them less than it promised.
 * These tests assert both cannot happen quietly.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  CREW_ROLE,
  CREW_FUNDING,
  CREW_PAYOUT_STATUS,
  easerIsOnBooking,
  easerMayCompleteBooking,
  laborPoolCents,
  proposeEvenSplit,
  marginImpact,
  crewEligibility,
  summarizeCrew,
} from '../api/booking/_crew.js';

const LEAD = '11111111-1111-4111-8111-111111111111';
const HELPER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

// A real $280 job: 8.25% tax inclusive, 30% platform fee.
const booking = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ref: 'AAE-CREW01',
  status: 'in_progress',
  assembler_id: LEAD,
  total_price: 28000,
  amount_charged: 28000,
  tax_amount: 2134,
  easer_fee_pct_snapshot: 30,
  payout_status: 'pending',
};

const leadRow = {
  easer_id: LEAD,
  role: CREW_ROLE.LEAD,
  due_cents: laborPoolCents(booking),
  funded_from: CREW_FUNDING.LABOR_POOL,
  payout_status: CREW_PAYOUT_STATUS.OWED,
  removed_at: null,
};

const ready = { ready: true };

// ── Pool ────────────────────────────────────────────────────────────────────
{
  const pool = laborPoolCents(booking);
  // revenue base 28000 - 2134 = 25866; 30% fee = 7760; labor = 18106
  assert.equal(pool, 18106, 'labor pool must come from the canonical split');
  // Sales tax is a pass-through liability and must never reach the payout base.
  assert.ok(pool < booking.total_price - booking.tax_amount + 1, 'tax must be excluded from the pool');
  console.log(`PASS labor pool excludes tax and platform fee ($${(pool / 100).toFixed(2)})`);
}

// ── Even split conserves every cent ─────────────────────────────────────────
{
  const proposal = proposeEvenSplit({ booking, crew: [leadRow], addingCount: 1 });
  const total = proposal.allocations.reduce((s, a) => s + a.dueCents, 0);
  assert.equal(total, proposal.poolCents, 'a split must never create or destroy a cent');
  assert.equal(proposal.headcount, 2);
  assert.equal(proposal.allocations.length, 2);

  // Odd pools must not vanish a cent: 18106 / 2 = 9053 exactly, so force an odd one.
  const oddBooking = { ...booking, total_price: 28001, amount_charged: 28001 };
  const odd = proposeEvenSplit({ booking: oddBooking, crew: [leadRow], addingCount: 2 });
  const oddTotal = odd.allocations.reduce((s, a) => s + a.dueCents, 0);
  assert.equal(oddTotal, odd.poolCents, 'remainder cents must be allocated, not dropped');
  const lead = odd.allocations.find(a => a.role === CREW_ROLE.LEAD);
  assert.ok(lead.dueCents >= odd.perPersonCents, 'remainder goes to the lead');
  console.log('PASS even split conserves the pool exactly, including odd remainders');
}

// ── A split that cuts existing pay must SAY SO ──────────────────────────────
{
  const proposal = proposeEvenSplit({ booking, crew: [leadRow], addingCount: 1 });
  assert.equal(proposal.reducesExistingPay, true, 'halving the lead must be reported');
  assert.equal(proposal.leadReductionCents, 18106 - 9053, 'the exact reduction must be named');
  const leadAlloc = proposal.allocations.find(a => a.easerId === LEAD);
  assert.ok(leadAlloc.deltaCents < 0, 'the lead delta must be negative and visible');
  console.log(`PASS a pay cut is computed and named ($${(proposal.leadReductionCents / 100).toFixed(2)}), never silent`);
}

// ── Margin funding surfaces the real cost ───────────────────────────────────
{
  const impact = marginImpact({ booking, helperDueCents: 6000 });
  assert.equal(impact.platformFeeCents, 7760);
  assert.equal(impact.remainingMarginCents, 1760, 'margin after a $60 helper');
  assert.equal(impact.goesNegative, false);

  const heavy = marginImpact({ booking, helperDueCents: 9000 });
  assert.equal(heavy.goesNegative, true, 'a helper who costs more than the fee must flag negative');
  console.log('PASS margin funding reports remaining margin, including when it goes negative');
}

// ── Access ──────────────────────────────────────────────────────────────────
{
  const crew = [leadRow, { easer_id: HELPER, role: CREW_ROLE.HELPER, due_cents: 5000, payout_status: 'owed', removed_at: null }];
  assert.equal(easerIsOnBooking(booking, crew, LEAD), true);
  assert.equal(easerIsOnBooking(booking, crew, HELPER), true, 'a helper can see the job');
  assert.equal(easerIsOnBooking(booking, crew, STRANGER), false, 'a stranger cannot');
  assert.equal(easerIsOnBooking(booking, [], LEAD), true, 'crew outage must not lock the lead out');

  // Completion stays with the lead: two people racing to complete is how a
  // double capture happens.
  assert.equal(easerMayCompleteBooking(booking, LEAD), true);
  assert.equal(easerMayCompleteBooking(booking, HELPER), false, 'a helper must not be able to complete or capture');
  console.log('PASS helpers get access but never completion/capture');
}

// ── Removed crew lose access and stop counting ──────────────────────────────
{
  const crew = [leadRow, { easer_id: HELPER, role: CREW_ROLE.HELPER, due_cents: 5000, payout_status: 'owed', removed_at: '2026-08-27T00:00:00Z', removed_reason: 'left early' }];
  assert.equal(easerIsOnBooking(booking, crew, HELPER), false, 'a removed helper loses access');
  const summary = summarizeCrew(crew);
  assert.equal(summary.headcount, 1, 'removed crew must not count toward headcount');
  assert.equal(summary.totalDueCents, leadRow.due_cents, 'removed crew must not be owed');
  console.log('PASS removed crew lose access and drop out of the totals');
}

// ── Eligibility ─────────────────────────────────────────────────────────────
{
  assert.equal(crewEligibility({ booking, crew: [leadRow], easerId: LEAD, readiness: ready }).reason, 'already_on_job');
  assert.equal(crewEligibility({ booking, crew: [leadRow], easerId: HELPER, readiness: { ready: false, blockingReason: 'Identity not verified' } }).message, 'Identity not verified',
    'the server reason must pass through, never be reinvented');
  assert.equal(crewEligibility({ booking: { ...booking, assembler_id: null }, crew: [], easerId: HELPER, readiness: ready }).reason, 'no_lead');
  assert.equal(crewEligibility({ booking: { ...booking, status: 'cancelled' }, crew: [leadRow], easerId: HELPER, readiness: ready }).reason, 'terminal_booking');

  const ok = crewEligibility({ booking, crew: [leadRow], easerId: HELPER, readiness: ready });
  assert.equal(ok.ok, true);
  assert.equal(ok.defaultFunding, CREW_FUNDING.LABOR_POOL, 'before payout, a helper splits the pool');
  assert.equal(ok.createsNewObligation, false);
  console.log('PASS eligibility blocks unready Easers and passes the server reason through');
}

// ── After payout, adding someone is a NEW obligation ────────────────────────
{
  for (const settled of ['paid', 'partial']) {
    const result = crewEligibility({ booking: { ...booking, status: 'completed', payout_status: settled }, crew: [leadRow], easerId: HELPER, readiness: ready });
    assert.equal(result.ok, true, 'adding is still allowed after payout');
    assert.equal(result.defaultFunding, CREW_FUNDING.PLATFORM_MARGIN,
      `with payout_status=${settled} the pool is already distributed, so margin funds it`);
    assert.equal(result.createsNewObligation, true, 'the owner must be told this is new money');
  }
  console.log('PASS adding crew after payout is allowed, funded from margin, and flagged as new money');
}

// ── The migration matches the module ────────────────────────────────────────
{
  const sql = await fs.readFile(new URL('../api/migrations/077_booking_crew.sql', import.meta.url), 'utf8');
  for (const value of Object.values(CREW_FUNDING)) {
    assert.ok(sql.includes(`'${value}'`), `funded_from '${value}' must exist in the migration's CHECK constraint`);
  }
  for (const value of Object.values(CREW_PAYOUT_STATUS)) {
    assert.ok(sql.includes(`'${value}'`), `payout_status '${value}' must exist in the migration`);
  }
  // The blocker this migration exists to remove.
  assert.ok(sql.includes('DROP INDEX IF EXISTS idx_payout_ledger_booking_unique'),
    'the single-payout-per-booking index must be dropped');
  assert.ok(sql.includes('idx_payout_ledger_booking_easer_unique'),
    'payout_ledger must be unique per (booking, easer), so a retry still cannot double-pay');
  // Exactly one lead.
  assert.ok(sql.includes('idx_booking_crew_one_active_lead'), 'exactly one active lead per booking must be enforced');
  // Backfill, or the table is silently empty for in-flight jobs.
  assert.ok(sql.includes('FROM public.bookings b') && sql.includes("'migration_077'"),
    'existing assigned bookings must be backfilled with a lead row');
  console.log('PASS migration 077 enforces every enum and constraint the module relies on');
}

console.log('\nBooking crew split tests passed.');
