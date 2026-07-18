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
assert.equal(ready.payout.status_code, 'manual_payout_ready');
assert.equal(ready.payout.status_label, 'Ready for Manual Payout');
assert.equal(ready.payout.action, 'none');

const held = toEaserEarningDto({
  ...baseRow,
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['offline_payment_not_verified'],
});
assert.equal(held.payout.disposition, 'on_hold');
assert.equal(held.payout.status_label, 'Payment Verification');
assert.match(held.payout.status_message, /not yet been recorded as collected/i);
assert.doesNotMatch(held.payout.status_message, /Stripe PaymentIntent|financial_operation|customer_name/i);

const evidenceHeld = toEaserEarningDto({
  ...baseRow,
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['completion_evidence_missing'],
});
assert.equal(evidenceHeld.payout.status_label, 'Photo Required');
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
  payoutDisposition: 'on_hold',
});
assert.equal(transferred.payout.disposition, 'transferred');
assert.equal(transferred.payout.status_label, 'Bank Payout Pending');
assert.match(transferred.payout.status_message, /not yet verified as paid/i);

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
assert.equal(bankPaid.payout.status_label, 'Bank Payout Paid');
assert.equal(bankPaid.payout.recorded_at, '2026-07-19T14:00:00.000Z');

const connectPending = toEaserEarningDto({
  ...baseRow,
  payoutMode: 'stripe_connect',
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['stripe_connect_path'],
});
assert.equal(connectPending.payout.disposition, 'pending');
assert.equal(connectPending.payout.status_label, 'Transfer Pending');

const connectPaymentHold = toEaserEarningDto({
  ...baseRow,
  payoutMode: 'stripe_connect',
  payoutDisposition: 'on_hold',
  payoutHoldCodes: ['stripe_connect_path', 'customer_payment_uncaptured'],
});
assert.equal(connectPaymentHold.payout.disposition, 'on_hold');
assert.equal(connectPaymentHold.payout.status_label, 'Payment Verification');

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

assert.match(payoutsPage, /fetch\('\/api\/assembler\/earnings'/);
assert.match(payoutsPage, /visibilitychange/);
assert.match(payoutsPage, /setInterval\(function\(\)/);
assert.match(payoutsPage, /refreshEarnings\(false\)/);
assert.match(payoutsPage, /Stripe Connect earnings show transfer and verified bank-payout status separately/);
assert.doesNotMatch(payoutsPage, /Awaiting Manual Payout/);
assert.doesNotMatch(payoutsPage, /fetch\('\/api\/booking\/my-assignments'/);
assert.match(assignmentsPage, /refreshEarningsTruth/);
assert.match(assignmentsPage, /await refreshEarningsTruth\(\);[\s\S]*renderAssignments\(filterList\(allAssignments, cf\)\)/);
assert.match(assignmentsPage, /earningTruth\.payout\.status_label/);
assert.doesNotMatch(assignmentsPage, /Manual payout pending after customer payment capture/);

console.log('Easer payout truth tests: PASS');
