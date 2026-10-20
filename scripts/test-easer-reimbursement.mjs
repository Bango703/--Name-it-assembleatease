#!/usr/bin/env node
// Easer expense reimbursement (owner, 2026-10-17): a hotel night on a job that
// ran into a second day. Paid with the job, out of the platform's margin, and
// never counted as the Easer's earnings or on the 1099.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { easerPayoutDueCents, computeBookingFinancialSummary } from '../api/_source-of-truth.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// ── One answer for what a booking pays its Easer ────────────────────────────
assert.equal(easerPayoutDueCents({ status: 'completed', assembler_due: 95000, easer_bonus_cents: 2000, easer_reimbursement_cents: 18900 }), 115900,
  'a completed job pays earnings + bonus + reimbursement');
assert.equal(easerPayoutDueCents({ status: 'completed', assembler_due: 95000 }), 95000, 'missing extras count as zero');
assert.equal(easerPayoutDueCents({ status: 'completed', assembler_due: 94710, easer_reimbursement_cents: 3000 }), 97710,
  'the completion email total includes a $30 reimbursement without adding it to earnings');
assert.equal(easerPayoutDueCents({ status: 'cancelled', cancellation_easer_due_cents: 4000, easer_bonus_cents: 2000, easer_reimbursement_cents: 18900 }), 4000,
  'a cancellation pays only the cancellation share');
console.log('PASS easerPayoutDueCents: earnings + bonus + reimbursement; cancellations carry neither');

// ── The reimbursement is a cost to the business, never Easer earnings ───────
{
  const base = { amountChargedCents: 146462, taxAmountCents: 11000, stripeFeeCents: 4277, assemblerDueCents: 94632 };
  const without = computeBookingFinancialSummary(base);
  const unpaid = computeBookingFinancialSummary({ ...base, easerReimbursementCents: 18900 });
  assert.equal(unpaid.easerCostCents, without.easerCostCents, 'earnings are unchanged by a reimbursement');
  assert.equal(unpaid.easerReimbursementCents, 18900);
  assert.equal(unpaid.platformGrossCents, without.platformGrossCents - 18900, 'the platform pays for it');
  assert.equal(unpaid.platformFeeCents, without.platformFeeCents - 18900);

  const paid = computeBookingFinancialSummary({ ...base, payoutAmountCents: 94632 + 18900, easerReimbursementCents: 18900 });
  assert.equal(paid.easerCostCents, 94632, 'a recorded payout has the reimbursement taken back out of earnings');
  assert.equal(paid.platformGrossCents, unpaid.platformGrossCents, 'paid and unpaid agree on the margin');
}
console.log('PASS financial summary: reimbursement lowers the margin and never raises Easer earnings');

// ── Every reader uses that answer; none adds the parts itself ───────────────
for (const rel of ['api/booking/payout.js', 'api/cron/release-payouts.js', 'api/owner/_finance-ledger.js', 'api/cron/daily-summary.js']) {
  const src = await read(rel);
  assert.match(src, /easerPayoutDueCents\(/, `${rel} uses easerPayoutDueCents`);
  assert.doesNotMatch(src, /assembler_due \|\| 0\) \+ Number\([a-z]+\.easer_bonus_cents/, `${rel} does not add earnings and bonus itself`);
}
const release = await read('api/cron/release-payouts.js');
assert.match(release, /'easer_bonus_cents', 'easer_reimbursement_cents',/, 'the Connect recheck reloads the reimbursement');
assert.match(release, /reimbursementCents: String\(/, 'the Stripe transfer records how much of it repays a cost');
console.log('PASS payout rails, owner ledger and daily summary all pay easerPayoutDueCents');

// ── The database agrees, and keeps the reimbursed part on the ledger ────────
const sql = await read('api/migrations/112_easer_reimbursement.sql');
assert.match(sql, /canonical_due_cents := COALESCE\(booking_row\.assembler_due, 0\)\s*\+ COALESCE\(booking_row\.easer_bonus_cents, 0\)\s*\+ v_reimbursement_cents;/,
  'record_booking_payout accepts earnings + bonus + reimbursement');
assert.match(sql, /normalized_method, v_reimbursement_cents\n\s*\);/, 'the ledger row stores the reimbursed part');
assert.match(sql, /bookings_easer_reimbursement_needs_reason/, 'a reimbursement needs a stated purpose');
assert.match(sql, /reimbursement_cents <= payout_amount/, 'the reimbursed part can never exceed the payout');
console.log('PASS migration 112: payout function and ledger match the API');

// ── 1099 leaves it out ──────────────────────────────────────────────────────
const dashboard = await read('api/owner/financial-dashboard.js');
assert.match(dashboard, /e\.ytdPaidCents \+= Math\.max\(0, Number\(row\.payout_amount \|\| 0\) - reimbursed\);/, '1099 totals exclude reimbursements');
console.log('PASS 1099 totals exclude reimbursements');

// ── The owner endpoint holds the rules ──────────────────────────────────────
const endpoint = await read('api/owner/easer-reimbursement.js');
assert.match(endpoint, /verifyOwner\(req\)/, 'owner only');
assert.match(endpoint, /REIMBURSEMENT_REASON_REQUIRED/, 'a purpose is required');
assert.match(endpoint, /PAYOUT_ALREADY_SENT/, 'fixed once paid');
assert.match(endpoint, /\.is\('financial_operation_key', null\)/, 'never changed under a payout in progress');
assert.match(endpoint, /\.or\('payout_status\.is\.null,payout_status\.not\.in\.\(paid,transferred\)'\)/, 'unfinished jobs with no payout status can be reimbursed');
assert.match(endpoint, /notificationType: 'easer_reimbursement_added'/, 'the Easer is told in writing');
assert.match(endpoint, /easerPayoutDueCents\(\{ \.\.\.booking, easer_reimbursement_cents: amount \}\)/,
  'a reimbursement added after completion uses the canonical total payout');
assert.match(endpoint, /Total payout/, 'a completed-job reimbursement email shows the updated total');
assert.match(endpoint, /Earnings<\/td>/, 'the completed-job reimbursement email keeps earnings distinct');
const owner = await read('owner/index.html');
assert.match(owner, /fetch\('\/api\/owner\/easer-reimbursement'/, 'the owner dashboard sets it through the endpoint');
console.log('PASS owner endpoint and dashboard');

// ── Completion email itemizes all money included in the payout ───────────────
{
  const completion = await read('api/booking/assembler-complete.js');
  assert.match(completion, /easerPayoutDueCents\(\{\s*\.\.\.booking,\s*status: BOOKING_STATUS\.COMPLETED,\s*assembler_due: assemblerDue,?\s*\}\)/,
    'the email total uses the canonical Easer payout calculation');
  assert.match(completion, /Total payout/, 'the headline is the full payout, not earnings alone');
  assert.match(completion, /Earnings\$\{sameDay\.bonusCents/,
    'the earnings row labels an included same-day bonus');
  assert.match(completion, /Bonus<\/td>/, 'owner-funded bonus is shown separately');
  assert.match(completion, /Reimbursement<\/td>/, 'the reimbursement is shown separately');
  assert.match(completion, /reimbursement repays your approved job expense and is separate from earnings/,
    'the reimbursement is clearly distinguished from earnings');
}
console.log('PASS Easer completion email: canonical total with separate earnings, bonus and reimbursement');

// ── The Easer sees it beside earnings, never inside them ───────────────────
{
  const { toEaserEarningDto, summarizeEaserEarnings } = await import('../api/assembler/_earnings.js');
  const row = { bookingId: 'b1', ref: 'AAE-1', service: 'TV Mounting', owed: 94632 + 18900, reimbursementCents: 18900, payoutMode: 'manual', payoutStatus: 'pending', holdReasons: [], holdCodes: [] };
  const dto = toEaserEarningDto(row);
  assert.equal(dto.amount_cents, 94632, 'earnings on the Easer screen leave the reimbursement out');
  assert.equal(dto.reimbursement_cents, 18900, 'the reimbursement is reported beside the earnings');
  const summary = summarizeEaserEarnings([dto]);
  assert.equal(summary.total_earned_cents, 94632, 'total earned is earnings only');
  assert.equal(summary.reimbursed_cents, 18900);
}
console.log('PASS Easer earnings screen: reimbursement beside earnings, never inside');

console.log('\nEaser reimbursement tests passed.');
