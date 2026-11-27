#!/usr/bin/env node
// Financials overview (owner console, 2026-11-13). The chart, the revenue
// breakdown and the Easer table are built on the server from the same rows as
// the totals: the months add up to the totals, the four parts add up to
// customer payments, the Easers add up to Easer earnings. The page draws them
// and never sums money itself.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMonthlySeries, buildRevenueBreakdown, buildEaserEarnings } from '../api/owner/financial-dashboard.js';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const rows = [
  // Completed late on Oct 31 in Austin: 03:00 UTC on Nov 1 is October locally.
  { status: 'completed', eventAt: '2026-11-01T03:00:00Z', netCharged: 21650, taxCollected: 1650, stripeFee: 658, paidOut: true, payoutAmount: 14000, assemblerId: 'e1', assemblerName: 'Alex' },
  { status: 'completed', eventAt: '2026-11-05T18:00:00Z', netCharged: 54125, taxCollected: 4125, stripeFee: 1600, paidOut: false, owed: 35000, assemblerId: 'e2', assemblerName: 'Sam' },
  { status: 'completed', date: '2026-11-20', netCharged: 10825, taxCollected: 825, stripeFee: 344, paidOut: false, owed: 7000, assemblerId: 'e1', assemblerName: 'Alex' },
  { status: 'cancelled', eventAt: '2026-09-10T15:00:00Z', netCharged: 2500, taxCollected: 0, stripeFee: 103, paidOut: true, payoutAmount: 1000, assemblerId: 'e2', assemblerName: 'Sam' },
  { status: 'completed', netCharged: 5000, taxCollected: 380, stripeFee: 175, paidOut: false, owed: 0 },
];
const sum = (list, f) => list.reduce((t, r) => t + f(r), 0);
const easer = r => (r.paidOut ? Number(r.payoutAmount || 0) : Number(r.owed || 0));
const totals = {
  customerRevenue: sum(rows, r => r.netCharged),
  salesTaxCollected: sum(rows, r => r.taxCollected),
  processingFees: sum(rows, r => r.stripeFee),
  easerPayouts: sum(rows, easer),
};
totals.platformGrossProfit = totals.customerRevenue - totals.salesTaxCollected - totals.processingFees - totals.easerPayouts;

// Months: Central-time months, an undated bucket last, and every total adds up.
const monthly = buildMonthlySeries(rows);
assert.deepEqual(monthly.map(m => m.month), ['2026-09', '2026-10', '2026-11', null]);
assert.equal(monthly.find(m => m.month === '2026-10').customerRevenue, 21650, 'a late-evening Oct 31 job is October in Austin');
assert.equal(monthly.find(m => m.month === '2026-11').completedJobs, 2);
assert.equal(sum(monthly, m => m.customerRevenue), totals.customerRevenue);
assert.equal(sum(monthly, m => m.salesTax), totals.salesTaxCollected);
assert.equal(sum(monthly, m => m.processingFees), totals.processingFees);
assert.equal(sum(monthly, m => m.easerEarnings), totals.easerPayouts);
assert.equal(sum(monthly, m => m.platformGross), totals.platformGrossProfit);

// Breakdown: four parts that add up to customer payments.
const breakdown = buildRevenueBreakdown(totals);
assert.equal(breakdown.totalCents, totals.customerRevenue);
assert.equal(sum(breakdown.parts, p => p.cents), totals.customerRevenue);
assert.ok(Math.abs(sum(breakdown.parts, p => p.share) - 1) < 1e-9);
assert.deepEqual(buildRevenueBreakdown({}).parts.map(p => p.share), [0, 0, 0, 0], 'no revenue, no shares');

// Easers: earned = paid + owed, and all Easers add up to Easer earnings.
const easers = buildEaserEarnings(rows);
assert.deepEqual(easers.map(e => e.name), ['Sam', 'Alex']);
const alex = easers.find(e => e.name === 'Alex');
assert.deepEqual([alex.jobs, alex.earnedCents, alex.paidCents, alex.owedCents], [2, 21000, 14000, 7000]);
easers.forEach(e => assert.equal(e.earnedCents, e.paidCents + e.owedCents));
assert.equal(sum(easers, e => e.earnedCents), totals.easerPayouts);

// The response carries them, and the page draws them without summing money.
const api = read('api/owner/financial-dashboard.js');
assert.match(api, /    monthly,\n    breakdown,\n    easerEarnings,\n/);
const page = read('owner/index.html');
const overview = page.slice(page.indexOf('function renderFinanceOverview(d)'), page.indexOf('// end renderFinanceOverview'));
assert.ok(overview.length > 200, 'one overview renderer');
assert.doesNotMatch(overview, /\.reduce\(/, 'the overview never adds money up itself');

// One place for per-service jobs and revenue (owner, 2026-11-27: "are these all just
// duplicates?"). Service Profitability has Jobs and Revenue from the server; the
// More tab used to recount both in the browser as two bar charts.
assert.ok(page.includes('id="an-service-profit-body"'), 'Service Profitability stays');
assert.doesNotMatch(page, /id="an-services"|id="an-rev-service"|Top Services by Volume|Revenue by Service/, 'no second copy of jobs or revenue per service');
const breakdowns = page.slice(page.indexOf('function renderFinancialBreakdowns(d)'), page.indexOf('async function loadPayoutLedger()'));
assert.ok(breakdowns.length > 100);
assert.doesNotMatch(breakdowns, /customerRevenue/, 'the page does not total revenue per service itself');
// The payout ledger is all time while the period buttons sit above it; it says so.
assert.match(page, /Easer Payout Ledger <span class="fin-card-note">All time, apart from the period above<\/span>/);

console.log('PASS finance overview: months, breakdown and Easer table add up to the totals; built on the server, drawn by the page.');
