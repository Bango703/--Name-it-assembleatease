#!/usr/bin/env node
// 1099-NEC totals cover both payout rails and leave reimbursements out; the
// Stripe Delta file subtracts reimbursements paid inside Stripe transfers.
// (Owner, 2026-10-20: Stripe files the 1099s for Easers paid by Stripe.)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadContractorTaxYear, stripeAdjustmentCsv, defaultTaxYear, NEC_THRESHOLD_CENTS,
} from '../api/owner/_contractor-tax.js';

function fakeSb(tables) {
  class Q {
    constructor(t) { this.t = t; this.f = []; }
    select() { return this; }
    gte(k, v) { this.f.push(r => r[k] >= v); return this; }
    lt(k, v) { this.f.push(r => r[k] < v); return this; }
    not(k, _op, v) { this.f.push(r => (r[k] ?? null) !== v); return this; }
    then(res, rej) { return Promise.resolve({ data: (tables[this.t] || []).filter(r => this.f.every(f => f(r))), error: null }).then(res, rej); }
  }
  return { from: t => new Q(t) };
}

const sb = fakeSb({
  payout_ledger: [
    { assembler_id: 'travis', assembler_name: 'Travis', payout_amount: 41557, reimbursement_cents: 0, recorded_at: '2026-09-01T00:00:00Z' },
    { assembler_id: 'phil', assembler_name: 'Phil', payout_amount: 20000, reimbursement_cents: 5000, recorded_at: '2026-05-01T00:00:00Z' },
    { assembler_id: 'phil', assembler_name: 'Phil', payout_amount: 99999, reimbursement_cents: 0, recorded_at: '2025-12-31T23:00:00Z' },
  ],
  bookings: [
    { id: 'b1', status: 'completed', assembler_id: 'phil', assembler_name: 'Phil', payout_amount: 97710, easer_reimbursement_cents: 3000, stripe_destination_account_id: 'acct_PHIL', stripe_transfer_id: 'tr_1', stripe_transfer_created_at: '2026-10-20T00:00:21Z' },
    { id: 'b2', status: 'completed', assembler_id: 'phil', assembler_name: 'Phil', payout_amount: 120000, easer_reimbursement_cents: 0, stripe_destination_account_id: 'acct_PHIL', stripe_transfer_id: 'tr_2', stripe_transfer_created_at: '2026-11-02T00:00:00Z' },
    { id: 'b3', status: 'cancelled', assembler_id: 'trap', assembler_name: 'Trapper', payout_amount: 4000, easer_reimbursement_cents: 2500, stripe_destination_account_id: 'acct_TRAP', stripe_transfer_id: 'tr_3', stripe_transfer_created_at: '2026-06-01T00:00:00Z' },
    { id: 'b4', status: 'completed', assembler_id: 'test', assembler_name: 'Test', payout_amount: 50000, stripe_destination_account_id: 'acct_T', stripe_transfer_id: 'tr_4', stripe_transfer_created_at: '2026-06-01T00:00:00Z', is_test_booking: true },
  ],
});

const tax = await loadContractorTaxYear(sb, 2026);
const by = Object.fromEntries(tax.easers.map(e => [e.assemblerId, e]));
assert.equal(by.phil.stripePaidCents, 94710 + 120000, 'Stripe pay leaves the reimbursement out');
assert.equal(by.phil.manualPaidCents, 15000, 'manual pay leaves the ledger reimbursement out; last year is excluded');
assert.equal(by.phil.ytdPaidCents, 94710 + 120000 + 15000);
assert.equal(by.phil.ytdReimbursedCents, 3000 + 5000);
assert.equal(by.phil.needs1099, by.phil.ytdPaidCents >= NEC_THRESHOLD_CENTS);
assert.equal(by.trap.stripePaidCents, 4000, 'a cancellation payout carries no reimbursement');
assert.equal(by.test, undefined, 'test bookings never count');
console.log('PASS 1099 totals: both rails, this year only, reimbursements left out, test bookings excluded');

const csv = stripeAdjustmentCsv(tax.easers);
assert.equal(csv, 'stripe_account_id,nonemployee_compensation_delta\nacct_PHIL,-30.00\n',
  'one Delta row per account, the full-year reimbursement in Stripe transfers, negative; manual reimbursements are not in Stripe');
console.log('PASS Stripe Delta file: stripe_account_id, nonemployee_compensation_delta, full-year negative amounts');

assert.equal(defaultTaxYear(new Date('2027-01-15T12:00:00Z')), 2026, 'in January the dashboard shows the year being filed');
assert.equal(defaultTaxYear(new Date('2026-10-20T12:00:00Z')), 2026);

const owner = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
assert.match(owner, /<th style="text-align:right">Paid by Stripe<\/th>/);
assert.match(owner, /id="ct-stripe-file"/, 'the owner can download the Stripe file');
const endpoint = await readFile(new URL('../api/owner/stripe-1099-adjustments.js', import.meta.url), 'utf8');
assert.match(endpoint, /verifyOwner\(req\)/);
console.log('PASS the dashboard shows both rails and offers the Stripe file; owner only');
