#!/usr/bin/env node

/**
 * Three owner powers that did not exist, and the rules that keep them safe.
 *
 *   1. Supply completion evidence FOR an Easer who could not upload it.
 *      Without it, one unresponsive Easer stranded their own payout forever.
 *   2. Waitlist an application instead of only approve/reject.
 *      Without it, a good applicant in a market that is not open had to be
 *      REJECTED — refunding their fee and losing the lead.
 *   3. Pay an Easer more than the split produced.
 *      Without it, the only options were to overpay off-platform, invisible to
 *      every report, or not at all.
 *
 * Each touches something dangerous — evidence authorship, an application
 * decision, and money — so each has a rule it must never break.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { computeBookingFinancialSummary, computeBookingSplit } from '../api/_source-of-truth.js';

const read = p => fs.readFile(new URL('../' + p, import.meta.url), 'utf8');

const loader = await read('api/booking/_completion-evidence.js');
const supply = await read('api/owner/supply-easer-evidence.js');
const payout = await read('api/booking/payout.js');
const ledger = await read('api/owner/_finance-ledger.js');
const release = await read('api/cron/release-payouts.js');
const update = await read('api/assembler/update.js');
const bonusApi = await read('api/owner/easer-bonus.js');
const summary = await read('api/cron/daily-summary.js');
const sot = await read('api/_source-of-truth.js');
const ui = await read('owner/index.html');
const mig084 = await read('api/migrations/084_evidence_uploaded_on_behalf_of.sql');
const mig085 = await read('api/migrations/085_easer_bonus.sql');

// ── 1. Evidence supplied for an Easer keeps honest authorship ──────────────
{
  // The shortcut would be to write uploaded_by = the Easer. That clears the
  // payout hold AND puts a false statement in the one record that matters in a
  // damage dispute. Evidence with the wrong author is worse than none.
  assert.ok(supply.includes('uploaded_by: ownerProfile.id'),
    'the uploader recorded must be whoever actually uploaded');
  assert.ok(supply.includes('uploaded_on_behalf_of: booking.assembler_id'),
    'who it was supplied for is recorded separately, not by faking authorship');
  assert.ok(mig084.includes('CHECK (uploaded_on_behalf_of IS NULL OR uploaded_on_behalf_of <> uploaded_by)'),
    'the database must reject "supplied on behalf of myself"');

  // It releases the payout, and only the payout.
  assert.ok(payout.includes('acceptSuppliedOnBehalf: true'), 'the payout gate must accept owner-supplied evidence');
  assert.ok(ledger.includes('acceptSuppliedOnBehalf: true'),
    'the ledger must use the same rule as the payout endpoint, or the panel and the money disagree');
  assert.ok(ledger.includes('uploaded_on_behalf_of'),
    'the ledger query must select the column or every supplied photo reads as missing');

  // ── The deadlock ─────────────────────────────────────────────────────────
  // First cut required the job to be COMPLETED before evidence could be
  // supplied. That made the job unfinishable: the Easer could not press
  // Complete without a photo, the owner could not complete it either because
  // complete.js demanded an Easer-authored photo, and the owner could not
  // supply one because the job was not complete. Stuck forever, money behind it.
  assert.ok(supply.includes("const workStarted = Boolean(booking.job_started_at) || booking.status === 'completed';"),
    'evidence must be suppliable once work has STARTED, or the job cannot be finished at all');
  assert.ok(!supply.includes("code: 'NOT_COMPLETED'"),
    'requiring completion before evidence is what created the deadlock');
  assert.ok(supply.includes("code: 'JOB_NOT_LIVE'"),
    'a cancelled job must still be refused — there is no work to document');

  const ownerComplete = await read('api/booking/complete.js');
  assert.ok(/loadCurrentCompletionEvidence\(sb, booking, \{[\s\S]{0,60}acceptSuppliedOnBehalf: true/.test(ownerComplete),
    'the OWNER completion path must accept evidence the owner supplied, or the deadlock remains');

  // But the EASER's own completion is deliberately untouched: someone standing
  // in the customer's home has no excuse for submitting another person's photo.
  const easerComplete = await read('api/booking/assembler-complete.js');
  assert.ok(easerComplete.includes('const completionEvidenceResult = await loadCurrentCompletionEvidence(sb, booking);'),
    'an Easer completing their own job must still supply their own photo');

  assert.ok(ui.includes("(booking.job_started_at || booking.status === 'completed')"),
    'the owner UI must offer this once work has started, not only after completion');

  // Supplied evidence is internal like any other upload — supplying is not publishing.
  assert.ok(supply.includes("visibility: 'owner'"),
    'owner-supplied evidence must not become customer-facing automatically');
  assert.ok(supply.includes("actorType: 'owner'"),
    'the timeline must say the owner did this, not the Easer');
  console.log('PASS evidence can be supplied for an Easer without faking who took it');
}

// ── 2. Waitlisting an application moves no money and is reversible ─────────
{
  assert.ok(update.includes("if (action === 'waitlist')"), 'there must be a third answer to an application');
  assert.ok(update.includes("application_status: 'waitlist'"), 'it must use the status the database already allows');

  // Not a finalization: no decision key, no refund, no Stripe.
  const block = update.slice(update.indexOf("if (action === 'waitlist')"), update.indexOf("if (action === 'suspend')"));
  assert.ok(!/claimApplicationDecision/.test(block), 'waitlisting must not finalize the application');
  // Reading application_fee_refund_id to DECIDE is fine; performing a refund is
  // not. Match the call, not the word.
  assert.ok(!/refunds\.create|paymentIntents\.(capture|cancel|create)/.test(block),
    'waitlisting must not move money');

  // Holding a paid applicant's $30 for a decision we have not made is not
  // defensible, so it refuses rather than quietly sitting on the fee.
  assert.ok(block.includes("code: 'WAITLIST_BLOCKED_BY_PAID_FEE'"),
    'a captured application fee must block waitlisting, with a stated reason');
  assert.ok(block.includes("notificationType: 'easer_application_waitlisted'"),
    'the applicant must be told — silence reads as rejection');
  // The applicant came to US. The email must not reference a conversation that
  // never happened, and must not claim their area is closed — that is a reason
  // we may not have and would have to stand behind the next time they asked.
  const waitlistEmail = await read('api/_waitlist-email.js');
  const { buildWaitlistEmail } = await import('../api/_waitlist-email.js');
  const applied = buildWaitlistEmail({ name: 'Phil Hawkins', city: 'Houston', state: 'TX', variant: 'applied' });
  assert.ok(!/following our conversation/i.test(applied.html),
    'a self-submitted applicant must not be told we spoke');
  assert.ok(!/not open|opening in your area|area just yet/i.test(applied.html),
    'the email must not claim a market is closed');
  assert.ok(/Thank you for applying/i.test(applied.html), 'it must acknowledge the application they actually made');
  assert.ok(/you applied to join/i.test(applied.html), 'the footer must state the real reason they received it');
  for (const part of ['ON WAITLIST', 'What Happens Next', 'Why Professionals Choose Us', 'Visit AssembleAtEase']) {
    assert.ok(applied.html.includes(part), `a waitlisted applicant must get the same branded ${part} as a signup`);
  }
  // A missing city must not render as a stray comma where a place should be.
  assert.ok(/professionals in your area/.test(buildWaitlistEmail({ name: 'X', variant: 'applied' }).html),
    'with no location on file the copy must stay neutral, not print an empty place');
  assert.ok(waitlistEmail.includes("APPLIED: 'applied'"), 'the variant must be named in one place');
  assert.ok(update.includes('WAITLIST_EMAIL_VARIANT.APPLIED'),
    'the waitlist action must use the shared branded template, not a hand-rolled one');

  assert.ok(ui.includes('data-waitlist-asm'), 'the owner needs the button');
  console.log('PASS an application can be waitlisted without money moving or a door closing');
}

// ── 3. A bonus rides on top of the split, never through it ────────────────
{
  // computeBookingSplit is THE answer to how a job's money divides and must
  // stay a pure function of what the customer paid.
  assert.ok(!/bonus/i.test(sot.slice(sot.indexOf('export function computeBookingSplit'), sot.indexOf('export function computeBookingSplitAtFeePct'))),
    'the canonical split must know nothing about bonuses');
  const split = computeBookingSplit(64842, false, { taxCents: 4942 });
  assert.equal(split.assemblerDueCents, 41930, 'the split is unchanged by any of this');

  // The margin absorbs it, exactly.
  const without = computeBookingFinancialSummary({ amountChargedCents: 64842, taxAmountCents: 4942, stripeFeeCents: 1910, assemblerDueCents: 41930 });
  const with50 = computeBookingFinancialSummary({ amountChargedCents: 64842, taxAmountCents: 4942, stripeFeeCents: 1910, assemblerDueCents: 41930, easerBonusCents: 5000 });
  assert.equal(without.platformGrossCents - with50.platformGrossCents, 5000,
    'a bonus must come out of platform margin, penny for penny');
  assert.equal(with50.easerCostCents, 46930, 'the bonus counts as an Easer cost before it is paid, not after');

  // BOTH payout rails must actually pay it, or the promise is a lie.
  assert.ok(payout.includes("Number(booking.assembler_due || 0) + Number(booking.easer_bonus_cents || 0)"),
    'the manual payout rail must include the bonus');
  assert.ok(release.includes("Number(b.assembler_due || 0) + Number(b.easer_bonus_cents || 0)"),
    'the Stripe Connect rail must include the bonus');
  assert.ok(release.includes("'easer_bonus_cents',") || /easer_bonus_cents,/.test(release),
    'the Connect projection must select the column or the bonus silently reads as 0');

  // A bonus is a gift, never a pay cut, and never unexplained.
  assert.ok(mig085.includes('CHECK (easer_bonus_cents >= 0)'), 'a negative bonus would be a pay cut in disguise');
  assert.ok(mig085.includes('CHECK (easer_bonus_cents <= 50000)'), 'a fat-finger ceiling is required');
  assert.ok(/easer_bonus_reason IS NOT NULL/.test(mig085), 'money paid without a reason is unauditable later');
  assert.ok(bonusApi.includes("code: 'PAYOUT_ALREADY_SENT'"),
    'a bonus must freeze once the payout has gone out, or the books disagree with the bank');
  assert.ok(bonusApi.includes("notificationType: 'easer_bonus_added'"),
    'an Easer must learn about a bonus from us, not from a bank statement (Rule 10)');
  assert.ok(bonusApi.includes('writeFinancialAudit'), 'every movement of money leaves a trail, gifts included');
  console.log('PASS a bonus is paid by both rails, absorbed by margin, and never enters the split');
}

// ── 4. The owner is told what they owe ─────────────────────────────────────
{
  assert.ok(summary.includes("eq('payout_status', 'pending')"),
    'the daily summary must ask what is still owed');
  assert.ok(summary.includes('owedTotalCents'), 'and total it');
  assert.ok(/daysWaiting/.test(summary),
    'how long an Easer has been waiting is the part that matters, not just the amount');
  assert.ok(summary.includes('Number(r.assembler_due || 0) + Number(r.easer_bonus_cents || 0)'),
    'what is owed includes any bonus, or the reminder understates it');
  console.log('PASS the daily summary names every unpaid Easer and how long they have waited');
}

console.log('\nOwner bonus / waitlist / evidence tests passed.');

// ── An error must not blame a migration that is applied ────────────────────
// Four handlers told the owner to "Apply migration 037" — a 3,591-line file
// that has been applied since long before. The real causes were a null column
// on one old booking, or any query error at all. Sending someone to re-run a
// migration for a one-column gap costs them an afternoon and teaches them to
// distrust the next message (Article 16).
{
  const files = [
    'api/booking/payout.js',
    'api/booking/list.js',
    'api/booking/reschedule.js',
    'api/booking/_cancellation-policy-truth.js',
  ];
  for (const f of files) {
    const src = await read(f);
    assert.ok(!/Apply migration 037/.test(src),
      `${f} must not blame migration 037 — it is applied, and that was never the verified cause`);
  }
  const payoutSrc = await read('api/booking/payout.js');
  assert.ok(/Set payout_mode_snapshot to manual .* or stripe_connect/.test(payoutSrc),
    'a missing payout mode must tell the owner the actual fix, not a migration number');
  const listSrc = await read('api/booking/list.js');
  assert.ok(/unreadError\.message \|\| 'reason unknown'/.test(listSrc),
    'a query failure must pass through Postgres\'s own words or admit the reason is unknown');
  console.log('PASS no handler blames an applied migration for a per-booking gap');
}
