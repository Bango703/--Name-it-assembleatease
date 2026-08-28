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
  splitPressure,
  fundingIsAllowedForNewCrew,
  ALLOWED_NEW_FUNDING,
  crewEligibility,
  summarizeCrew,
} from '../api/booking/_crew.js';
import { getEaserReadiness } from '../api/_easer-readiness.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';

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

// A profile that satisfies every readiness gate, so the readiness object below is
// the REAL one rather than a hand-written stand-in. Writing `{ ready: true }` here
// is what let _crew.js read a field name that does not exist: the module checked
// `readiness.ready` while getEaserReadiness() returns `isReady`, which would have
// rejected every genuinely ready Easer. The fixture must come from the real
// function or the test just re-states the bug.
const readyProfile = {
  id: HELPER,
  role: 'assembler',
  status: 'active',
  application_status: 'approved',
  tier: 'professional',
  identity_verified: true,
  contractor_agreement_signed_at: '2026-08-20T00:00:00Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-08-20T00:00:00Z',
  application_fee_paid: true,
  payment_confirmed: true,
  phone: '5125550147',
  is_available: true,
};
const ready = await getEaserReadiness(readyProfile, { connectRequired: false });

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

// ── The platform never funds a helper ──────────────────────────────────────
// The owner's ruling: "If a job requires 2 people then the cost of the job is
// not enough. The owner will not take a loss." Enforced in the domain, not by
// hiding a radio button.
{
  assert.deepEqual([...ALLOWED_NEW_FUNDING].sort(), ['change_order', 'labor_pool'],
    'only the job\'s own pay or a customer-approved change order may fund new crew');
  assert.equal(fundingIsAllowedForNewCrew(CREW_FUNDING.PLATFORM_MARGIN), false,
    'platform_margin must be refused for any NEW crew member');
  assert.equal(fundingIsAllowedForNewCrew(CREW_FUNDING.LABOR_POOL), true);
  assert.equal(fundingIsAllowedForNewCrew(CREW_FUNDING.CHANGE_ORDER), true);
  // The value survives in the enum so historical rows stay readable — the
  // migration's CHECK still permits it and old data must not become unreadable.
  assert.equal(CREW_FUNDING.PLATFORM_MARGIN, 'platform_margin',
    'the historical value must remain defined for reading existing rows');
  console.log('PASS the platform can never fund a helper out of margin');
}

// ── The split is a PRICING signal ──────────────────────────────────────────
{
  const pressure = splitPressure({ booking, crew: [leadRow], addingCount: 1 });
  assert.equal(pressure.soloPoolCents, 18106, 'what one Easer would have earned alone');
  assert.equal(pressure.perPersonCents, 9053, 'what each earns once split');
  assert.equal(pressure.underpricedSignal, true,
    'any split means the job priced for one person now pays two — that is a pricing problem, surfaced');
  console.log(`PASS a split reports the pricing signal ($${(pressure.soloPoolCents/100).toFixed(2)} -> $${(pressure.perPersonCents/100).toFixed(2)} each)`);
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
  // The contract test. If getEaserReadiness ever renames isReady, or crewEligibility
  // drifts back to a field that does not exist, this fails instead of silently
  // refusing every Easer on the platform.
  assert.equal(ready.isReady, true, 'the fixture profile must actually be ready');
  assert.equal(
    crewEligibility({ booking, crew: [leadRow], easerId: HELPER, readiness: ready }).ok,
    true,
    'a genuinely READY Easer must be addable — this is the check that catches a readiness field rename',
  );

  assert.equal(crewEligibility({ booking, crew: [leadRow], easerId: LEAD, readiness: ready }).reason, 'already_on_job');

  // An unready Easer is refused with the SERVER's own wording, not an invented one.
  const unready = await getEaserReadiness({ ...readyProfile, identity_verified: false }, { connectRequired: false });
  const refusal = crewEligibility({ booking, crew: [leadRow], easerId: HELPER, readiness: unready });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /Identity verified/,
    'the refusal must name the actual missing gate, from the canonical readiness message');
  assert.equal(crewEligibility({ booking, crew: [leadRow], easerId: HELPER, readiness: undefined }).ok, false,
    'missing readiness must fail closed, never open');
  assert.equal(crewEligibility({ booking: { ...booking, assembler_id: null }, crew: [], easerId: HELPER, readiness: ready }).reason, 'no_lead');
  assert.equal(crewEligibility({ booking: { ...booking, status: 'cancelled' }, crew: [leadRow], easerId: HELPER, readiness: ready }).reason, 'terminal_booking');

  const ok = crewEligibility({ booking, crew: [leadRow], easerId: HELPER, readiness: ready });
  assert.equal(ok.ok, true);
  assert.equal(ok.defaultFunding, CREW_FUNDING.LABOR_POOL, 'before payout, a helper splits the pool');
  assert.equal(ok.createsNewObligation, false);
  console.log('PASS eligibility blocks unready Easers and passes the server reason through');
}

// ── After payout there is nothing left to split ────────────────────────────
// This used to fall back to platform_margin. That is the silent write-off the
// owner ruled out, so it now refuses and names the only honest route.
{
  for (const settled of ['paid', 'partial']) {
    const result = crewEligibility({ booking: { ...booking, status: 'completed', payout_status: settled }, crew: [leadRow], easerId: HELPER, readiness: ready });
    assert.equal(result.ok, false, `with payout_status=${settled} the pool is already distributed`);
    assert.equal(result.reason, 'payout_settled');
    assert.match(result.message, /change order/i,
      'the refusal must name the route that exists, not just say no (Article 16)');
    assert.ok(!/margin/i.test(result.message), 'the refusal must never offer the platform absorbing it');
  }
  console.log('PASS once paid out, crew cannot be added — the refusal points at a change order');
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

// ── The owner endpoint cannot be talked around ──────────────────────────────
{
  const src = await fs.readFile(new URL('../api/owner/crew.js', import.meta.url), 'utf8');

  assert.ok(src.includes('verifyOwner(req)'), 'the crew endpoint must require owner auth');
  assert.ok(/getEaserReadiness\(/.test(src),
    'adding crew must run the SAME readiness gate as dispatch — otherwise it is a back door around identity verification');
  assert.ok(src.includes("rpc('add_booking_crew_member'"),
    'the crew write must go through the atomic RPC, never separate updates');
  assert.ok(src.includes("rpc('remove_booking_crew_member'"),
    'removal must go through the RPC so the freed amount and payout status stay coherent');

  // The split must never be applied from a single click.
  assert.ok(src.includes('ALLOCATIONS_REQUIRED'),
    'add must refuse without a confirmed allocation, so a pay cut is a decision and not a side effect');
  assert.ok(src.includes('EXCEEDS_POOL'),
    'the handler must reject an over-allocation before it reaches the database');

  // No crew table writes outside the RPC.
  assert.ok(!/from\('booking_crew'\)[\s\S]{0,120}\.(insert|update|upsert|delete)\(/.test(src),
    'the endpoint must not write booking_crew directly — the RPC owns that transaction');

  // Rule 9: the customer must not be surprised by who enters their home.
  assert.ok(/recipientType: 'customer'/.test(src),
    'the customer must be told a second person is coming');
  assert.ok(src.includes("Your price hasn't changed"),
    'the customer notice must say the price did not change, or it reads as an upcharge');
  console.log('PASS the owner endpoint keeps auth, readiness, atomicity, and confirmation');
}

// ── Migration 078 enforces the money invariants server-side ─────────────────
{
  const sql = await fs.readFile(new URL('../api/migrations/078_add_crew_member_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('FOR UPDATE'),
    'the booking must be locked so two concurrent adds cannot both spend the same pool');
  assert.ok(/alloc_total > COALESCE\(p_pool_cents, 0\)/.test(sql),
    'the pool ceiling must be re-checked inside the transaction — a caller must not be able to over-allocate by posting different numbers');
  assert.ok(/alloc_count <> active_count \+ 1/.test(sql),
    'a partial allocation set must be rejected, not merged, or someone is left on a stale amount');
  assert.ok(/payout_status = 'owed'/.test(sql),
    'an already-paid crew member must not be silently rewritten — that would desync the ledger');
  assert.ok(/role = 'lead'[\s\S]{0,200}RAISE EXCEPTION/.test(sql),
    'the lead must not be removable through the crew path');
  assert.ok(/p_reason IS NULL OR btrim\(p_reason\) = ''/.test(sql),
    'removal must require a reason — a person vanishing from a job they worked is how a payout gets lost');
  console.log('PASS migration 078 re-validates the pool, locks the booking, and protects settled money');
}

// ── A helper can reach the job; only the lead can drive it ──────────────────
{
  const read = f => fs.readFile(new URL(`../api/booking/${f}`, import.meta.url), 'utf8');
  const [assignments, status, message, evidence, complete] = await Promise.all(
    ['my-assignments.js', 'easer-status.js', 'message.js', 'upload-evidence.js', 'assembler-complete.js'].map(read),
  );

  // SEE IT — a helper who cannot load the job is expected at an address they
  // cannot read.
  assert.ok(/from\('booking_crew'\)/.test(assignments) && /crewBookingIds/.test(assignments),
    'my-assignments must include jobs the Easer is on as crew, not only ones they lead');
  assert.ok(/assembler_id\.eq\.\$\{user\.id\},id\.in\./.test(assignments),
    'the job list must union led jobs with crew jobs in one query');

  // EARN THE RIGHT AMOUNT — showing a helper the whole pool promises pay we will
  // not send.
  assert.ok(/myShare\.crewSize > 1/.test(assignments),
    'the crew share must override the estimate ONLY on a genuinely crewed job, so single-Easer math is untouched');

  // WORK IT — messaging and evidence are half of doing the job.
  for (const [name, src] of [['message.js', message], ['upload-evidence.js', evidence]]) {
    assert.ok(/from\('booking_crew'\)/.test(src), `${name} must let a crew member in`);
    assert.ok(/removed_at/.test(src), `${name} must exclude removed crew`);
  }

  // NOT DRIVE IT — status and completion stay with the lead, so two people
  // cannot race the completion/capture path.
  assert.ok(/CREW_NOT_LEAD/.test(status),
    'a helper hitting the status endpoint must get the real reason, not "Not your booking" — they ARE on the booking');
  assert.ok(!/from\('booking_crew'\)/.test(complete),
    'assembler-complete must remain lead-only: two people completing one job is how a double capture happens');
  console.log('PASS a helper can see, message and photograph the job — only the lead advances or completes it');
}

console.log('\nBooking crew split tests passed.');
