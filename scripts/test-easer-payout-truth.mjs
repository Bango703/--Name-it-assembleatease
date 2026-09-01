#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  summarizeEaserEarnings,
  toEaserEarningDto,
} from '../api/assembler/_earnings.js';

const baseRow = {
  bookingId: '11111111-1111-4111-8111-111111111111',
  ref: 'AAE-PAYOUT01',
  service: 'King Bed Frame Assembly',
  eventAt: '2026-07-17T14:00:00.000Z',
  completedAt: '2026-07-17T14:00:00.000Z',
  assemblerId: '22222222-2222-4222-8222-222222222222',
  owed: 7113,
  payoutStatus: 'pending',
  payoutMode: 'manual',
  payoutDisposition: 'pending',
  payoutHoldCodes: [],
  cancellationEarnings: false,
  paidOut: false,
  customerName: 'Must not leak',
  customerEmail: 'must-not-leak@example.com',
  charged: 11000,
  taxCollected: 825,
  stripeFee: 349,
  platformRevenue: 1713,
};

const ready = toEaserEarningDto(baseRow);
assert.equal(ready.amount_cents, 7113);
assert.equal(ready.payout.disposition, 'pending');
assert.equal(ready.payout.status_code, 'pending');
assert.equal(ready.payout.status_label, 'Pending');
assert.equal(ready.payout.action, 'none');

const held = toEaserEarningDto({
  ...baseRow,
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['offline_payment_not_verified'],
});
assert.equal(held.payout.disposition, 'on_hold');
assert.equal(held.payout.status_label, 'On Hold');
assert.match(held.payout.status_message, /temporarily on hold/i);
assert.doesNotMatch(held.payout.status_message, /customer|owner|Stripe|financial_operation|review|reconcil/i);

const evidenceHeld = toEaserEarningDto({
  ...baseRow,
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['completion_evidence_missing'],
});
assert.equal(evidenceHeld.payout.status_label, 'Action Required');
assert.equal(evidenceHeld.payout.action, 'upload_completion_evidence');

const paid = toEaserEarningDto({
  ...baseRow,
  payoutStatus: 'paid',
  payoutDisposition: 'paid',
  paidOut: true,
  paidOutAt: '2026-07-18T14:00:00.000Z',
});
assert.equal(paid.payout.disposition, 'paid');
assert.equal(paid.payout.status_label, 'Paid');
assert.equal(paid.payout.recorded_at, '2026-07-18T14:00:00.000Z');

const transferred = toEaserEarningDto({
  ...baseRow,
  payoutStatus: 'transferred',
  payoutMode: 'stripe_connect',
  payoutDisposition: 'transferred',
});
assert.equal(transferred.payout.disposition, 'transferred');
assert.equal(transferred.payout.status_label, 'Processing');
assert.match(transferred.payout.status_message, /processing/i);

const unverifiedTransfer = toEaserEarningDto({
  ...baseRow,
  payoutStatus: 'transferred',
  payoutMode: 'stripe_connect',
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['payout_state_reconciliation'],
});
assert.equal(unverifiedTransfer.payout.disposition, 'on_hold');
assert.equal(unverifiedTransfer.payout.status_label, 'On Hold');

const bankPaid = toEaserEarningDto({
  ...baseRow,
  payoutStatus: 'transferred',
  payoutMode: 'stripe_connect',
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['stripe_connect_path', 'stripe_transfer_exists'],
  stripeBankPayoutStatus: 'paid',
  stripeBankPayoutPaidAt: '2026-07-19T14:00:00.000Z',
});
assert.equal(bankPaid.payout.disposition, 'paid');
assert.equal(bankPaid.payout.status_label, 'Paid');
assert.equal(bankPaid.payout.recorded_at, '2026-07-19T14:00:00.000Z');

const connectPending = toEaserEarningDto({
  ...baseRow,
  payoutMode: 'stripe_connect',
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['stripe_connect_path'],
});
assert.equal(connectPending.payout.disposition, 'pending');
assert.equal(connectPending.payout.status_label, 'Pending');

const connectPaymentHold = toEaserEarningDto({
  ...baseRow,
  payoutMode: 'stripe_connect',
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['stripe_connect_path', 'customer_payment_uncaptured'],
});
assert.equal(connectPaymentHold.payout.disposition, 'on_hold');
assert.equal(connectPaymentHold.payout.status_label, 'On Hold');

const serialized = JSON.stringify(ready);
for (const forbidden of [
  'customerName',
  'customerEmail',
  'charged',
  'taxCollected',
  'stripeFee',
  'platformRevenue',
  'holdReasons',
  'payout_notes',
]) {
  assert.equal(serialized.includes(forbidden), false, `Easer DTO must not expose ${forbidden}`);
}

const summary = summarizeEaserEarnings([ready, held, paid, transferred, bankPaid]);
assert.deepEqual(summary, {
  completed_jobs: 5,
  total_earned_cents: 35565,
  paid_cents: 14226,
  awaiting_payout_cents: 14226,
  on_hold_cents: 7113,
});

const load = path => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [endpointSource, payoutsPage, assignmentsPage, financeSource] = await Promise.all([
  load('api/assembler/earnings.js'),
  load('assembler/payouts.html'),
  load('assembler/my-assignments.html'),
  load('api/owner/_finance-ledger.js'),
]);

assert.match(endpointSource, /authenticateBearerUser\(req\)/);
assert.match(endpointSource, /profile\.role !== 'assembler'/);
assert.match(endpointSource, /normalizeEaserClosureStatus\(profile\) === 'completed'/);
assert.match(endpointSource, /loadLedgerFirstFinanceRows\(sb, \{ assemblerId: authenticated\.user\.id \}\)/);
assert.match(endpointSource, /row\.assemblerId === authenticated\.user\.id/);
assert.match(endpointSource, /Cache-Control['"], ['"]private, no-store/);
assert.doesNotMatch(endpointSource, /req\.query.*assembler|req\.body.*assembler/);
assert.match(financeSource, /if \(assemblerId\) bookingsQuery = bookingsQuery\.eq\('assembler_id', assemblerId\)/);

assert.match(payoutsPage, /APP\.privateFetch\(privateUserId, '\/api\/assembler\/earnings'/);
assert.match(payoutsPage, /visibilitychange/);
assert.match(payoutsPage, /setInterval\(function\(\)/);
assert.match(payoutsPage, /refreshEarnings\(false\)/);
assert.match(payoutsPage, /Each completed job shows your payout amount and current status/);
assert.doesNotMatch(payoutsPage, /Awaiting Manual Payout/);
assert.doesNotMatch(payoutsPage, /fetch\('\/api\/booking\/my-assignments'/);
assert.match(assignmentsPage, /refreshEarningsTruth/);
assert.match(assignmentsPage, /await refreshEarningsTruth\(\);[\s\S]*renderAssignments\(filterList\(allAssignments, cf\)\)/);
assert.match(assignmentsPage, /earningTruth\.payout\.status_label/);
assert.doesNotMatch(assignmentsPage, /Manual payout pending after customer payment capture/);

console.log('Easer payout truth tests: PASS');

// ── The rail that actually pays people must say so ─────────────────────────
// api/cron/release-payouts.js imported sendEmail and called it ZERO times. The
// automated Stripe Connect path — the one that pays almost every job — told the
// Easer nothing at all, while the rarely-used manual path sent a notice. Rule 10:
// an Easer must always know when and how they get paid.
{
  const releaseSrc = await fs.readFile(new URL('../api/cron/release-payouts.js', import.meta.url), 'utf8');
  const payoutSrc = await fs.readFile(new URL('../api/booking/payout.js', import.meta.url), 'utf8');

  assert.ok(releaseSrc.includes('await sendEmail({'),
    'the Connect payout cron must actually notify the Easer, not merely import the sender');
  assert.ok(releaseSrc.includes("notificationType: 'easer_payout_transferred'"),
    'the transfer notice needs its own notification type so failures are traceable');
  assert.ok(releaseSrc.includes("recipientType: 'easer'"),
    'the notice must go to the Easer, not only the owner');

  // A notification failure must never affect a transfer that already happened.
  assert.ok(/catch \(notifyErr\)/.test(releaseSrc),
    'a failed payout email must be caught — the money already moved (Rule 7)');

  // Timing is read from Stripe, not hardcoded: the schedule belongs to Stripe
  // and can differ per account.
  assert.ok(releaseSrc.includes('settings?.payouts?.schedule?.delay_days'),
    'payout timing must be read from the Easer\'s own Stripe account');
  assert.ok(payoutSrc.includes('viaStripeConnect'),
    'the payout email must have a Connect variant distinct from the manual one');

  // Number(null) is 0 and 0 is finite — without the null check this renders
  // "about 0 business days", the same trap that once made a null coordinate
  // read as a 3,000km distance.
  // Number(null) is 0 and 0 is finite, so without an explicit absence check the
  // copy renders "about 0 business days" — the same trap that once made a null
  // coordinate read as a 3,000km distance. The guard now lives in
  // expectedPayoutArrival, which returns null rather than a bogus day.
  assert.ok(payoutSrc.includes('if (delayDays == null || !Number.isFinite(days) || days <= 0) return null;'),
    'an unknown or zero schedule must produce no date at all, never "0 business days"');
  console.log('PASS a Stripe Connect payout tells the Easer, with timing read from Stripe');
}

// ── The Easer is told WHEN, not just that it moved ─────────────────────────
// "Transferred" told a pro their money had moved but not when they could spend
// it, which is the only part they needed. "About 2 business days" is a duration,
// not an answer.
{
  const { expectedPayoutArrival, formatPayoutArrival, buildPayoutEmail } =
    await import('../api/booking/payout.js');

  // Business days, so a Friday transfer does not promise Sunday.
  const fri = expectedPayoutArrival(new Date('2026-08-28T12:00:00Z'), 2);
  assert.equal(formatPayoutArrival(fri), 'Tuesday, September 1',
    'a Friday transfer with a 2-day delay must land Tuesday, not Sunday');
  assert.equal(formatPayoutArrival(expectedPayoutArrival(new Date('2026-08-27T12:00:00Z'), 2)), 'Monday, August 31');

  // An unknown schedule must produce NO date rather than a wrong one.
  assert.equal(expectedPayoutArrival(new Date(), null), null, 'an unknown schedule must not invent a date');
  assert.equal(expectedPayoutArrival(new Date(), 0), null, 'a zero delay must not render as "today"');
  assert.equal(expectedPayoutArrival('not-a-date', 2), null, 'an unparseable date must not produce a day');

  // The date is computed from when the customer's payment SETTLES and passed in.
  // The email must NOT invent one: doing so made the cron say Friday and the
  // email say Tuesday about the same payout.
  const settles = new Date('2026-09-02T00:00:00Z');
  const withDate = buildPayoutEmail({
    firstName: 'Trapper', ref: 'X', service: 'Furniture Assembly', date: '',
    payoutDisplay: '$419.30', notes: '', method: 'stripe', viaStripeConnect: true,
    delayDays: 2, arrivalAt: expectedPayoutArrival(settles, 2),
  });
  // The date sits inside <strong>, so compare against stripped text rather
  // than raw HTML — a regex across tags silently matches nothing and passes.
  const plain = h => String(h).replace(/<[^>]*>/g, '');
  assert.ok(/Expected in your bank account by Friday, September 4/.test(plain(withDate)),
    'the date must count from settlement, not from when the cron happened to run');
  assert.ok(!/business days? from now/.test(plain(withDate)),
    '"from now" was the wrong basis and must not return');
  assert.ok(/Your payment is processing/.test(plain(withDate)),
    'the Easer should receive a concise external status instead of Stripe settlement mechanics');
  assert.ok(!/queued with Stripe|customer's payment settles|Stripe charges a small fee|to get it the same day|job job/i.test(plain(withDate)),
    'the email must not expose settlement detail, sell another payout path, or duplicate service wording');
  assert.equal((plain(withDate).match(/\$419\.30/g) || []).length, 1,
    'the payment amount should appear once');
  assert.ok(/Instant payout may be available/.test(plain(withDate)),
    'Connect emails may point to the optional faster payout without promising eligibility');
  assert.ok(/href="https:\/\/www\.assembleatease\.com\/assembler\/payouts"/.test(withDate),
    'instant payout discovery must lead to the authenticated Payouts page where eligibility and fees are checked');

  // Given no settlement date, it must promise nothing.
  const noArrival = buildPayoutEmail({
    firstName: 'T', ref: 'X', service: 'S', date: '',
    payoutDisplay: '$1.00', notes: '', method: 'stripe', viaStripeConnect: true,
    delayDays: 2, arrivalAt: null,
  });
  assert.ok(!/Expect it by/.test(plain(noArrival)), 'with no settlement date the email must not name a day');

  const noDate = buildPayoutEmail({
    firstName: 'T', ref: 'X', service: 'S', date: '',
    payoutDisplay: '$1.00', notes: '', method: 'stripe', viaStripeConnect: true, delayDays: null, arrivalAt: null,
  });
  assert.ok(!/Expect it by/.test(noDate), 'with no schedule the email must not promise a day');
  assert.ok(/based on your payout schedule/.test(noDate), 'it must fall back to non-specific wording instead');

  const release = await fs.readFile(new URL('../api/cron/release-payouts.js', import.meta.url), 'utf8');
  assert.ok(release.includes('expected_bank_arrival_at:'), 'the estimate must be stored at transfer time');
  assert.ok(release.includes('fundsAvailableAt'),
    'the estimate must be based on when the charge settles, not on when the cron ran');
  assert.ok(release.includes("expand: ['latest_charge.balance_transaction']"),
    'available_on must be read from Stripe rather than assumed');
  assert.ok(!/expectedPayoutArrival\(new Date\(\)/.test(release),
    'counting from now() promised a date three days earlier than the truth');
  // The transfer already happened by the time this writes. A missing column must
  // never cost us the record of a real transfer.
  assert.ok(release.includes('const applyTransferState = patch =>'),
    'the transfer-state write must be retryable without the new column');
  assert.ok(/expected_bank_arrival_at\|PGRST204\|42703/.test(release),
    'a missing migration 086 must degrade, not lose the transfer record');

  const easerUi = await fs.readFile(new URL('../assembler/payouts.html', import.meta.url), 'utf8');
  assert.ok(easerUi.includes('Expect it by'), 'the Easer dashboard must show the date too, not only the email');
  console.log('PASS the Easer is told which day the money should land, or nothing at all');
}

// ── The hold is one number, not two that can drift ─────────────────────────
// The cron released after 48 hours from its own constant, while complete.js
// told the Easer "about 48 hours" from a hardcoded string. Changing one would
// have left the other quietly lying about when someone gets paid — and an Easer
// planning around money is exactly who must not be misinformed.
{
  const { PAYOUT_HOLD_HOURS } = await import('../api/_source-of-truth.js');
  assert.equal(PAYOUT_HOLD_HOURS, 24, 'the hold is 24 hours unless the env overrides it');

  const cron = await fs.readFile(new URL('../api/cron/release-payouts.js', import.meta.url), 'utf8');
  const complete = await fs.readFile(new URL('../api/booking/complete.js', import.meta.url), 'utf8');

  assert.ok(cron.includes("import { PAYOUT_HOLD_HOURS } from '../_source-of-truth.js';"),
    'the cron must import the canonical hold, not redeclare it');
  assert.ok(!/const PAYOUT_HOLD_HOURS\s*=/.test(cron),
    'a second declaration is how the two numbers drifted apart');

  assert.ok(complete.includes('${PAYOUT_HOLD_HOURS} hours after completion'),
    'the Easer-facing note must derive from the same constant');
  assert.ok(!/about 48 hours/.test(complete),
    'no surface may hardcode an hour count that the cron owns');
  console.log('PASS the payout hold is a single number every surface reads');
}
