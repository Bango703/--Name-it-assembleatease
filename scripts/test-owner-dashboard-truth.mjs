#!/usr/bin/env node
// Owner dashboard: one number, one source, never stale (owner, 2026-11-10:
// "look at inconsistent data within different areas and stale data").
// Each block below is a disagreement found on the live dashboard that day.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildCustomerTotals, customerKeyFor } from '../api/owner/financial-dashboard.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const owner = read('owner/index.html');
const fnSource = (name) => {
  const plain = owner.indexOf(`  function ${name}(`);
  const start = plain > 0 ? plain : owner.indexOf(`  async function ${name}(`);
  assert.ok(start > 0, name);
  const end = owner.indexOf('\n  }\n', start);
  return owner.slice(start, end + 4);
};

// Customers showed 3 repeat customers while Financials showed 0%: the page
// counted cancelled bookings and its own idea of "paid". Both now come from
// Financials' rows and its customer match.
{
  const rows = [
    { customerEmail: 'a@x.test', status: 'completed', netCharged: 16_238 },
    { customerEmail: 'A@x.test ', status: 'completed', netCharged: 10_000 },
    { customerEmail: 'b@x.test', status: 'completed', netCharged: 64_842 },
    { customerEmail: 'c@x.test', status: 'cancelled', cancellationEarnings: true, netCharged: 5_000 },
    { customerName: 'No Email', status: 'completed', netCharged: 2_000 },
  ];
  const totals = Object.fromEntries(buildCustomerTotals(rows).map((t) => [t.key, t]));
  assert.deepEqual([totals['email:a@x.test'].completedJobs, totals['email:a@x.test'].paidCents], [2, 26_238], 'same email, any case: one customer');
  assert.equal(totals['email:b@x.test'].paidCents, 64_842);
  assert.deepEqual([totals['email:c@x.test'].completedJobs, totals['email:c@x.test'].paidCents], [0, 5_000], 'a cancellation fee is money paid, not a completed job');
  assert.equal(totals['name:no email'].completedJobs, 1);
  // The page builds the same key as the server.
  const ctx = {};
  vm.runInNewContext(`${fnSource('customerKeyFor')}\nthis.k = customerKeyFor;`, ctx);
  for (const [email, name] of [['A@X.test ', 'Ann'], ['', 'Ann Lee '], [null, null], ['b@x.test', '']]) {
    assert.equal(ctx.k(email, name), customerKeyFor(email, name), `${email}/${name}`);
  }
  assert.match(owner, /c\.completedJobs = customerTotalsByKey \? \(t \? t\.completedJobs : 0\) : null;/);
  assert.match(owner, /var repeat = allCustomers\.filter\(function\(c\)\{return c\.completedJobs>1;\}\)\.length;/);
  assert.match(owner, /\(c\.spent==null \? '—' : fmt\$\(c\.spent\)\)/, 'unknown spend shows unknown, never $0');
}
console.log('PASS customers: spent and repeat are Financials\' numbers, matched the same way');

// Bookings said "1 needs reconciliation" while Financials showed all 8 complete,
// and the Financial Report was a third calculation. The page now has no money
// rule of its own.
{
  assert.doesNotMatch(owner, /function actualNetPaymentsCents|function completedFinanceReady/);
  assert.match(fnSource('paintPlatformGrossTile'), /var d = await loadAllTimeFinance\(false\);[\s\S]*fmtSigned\$\(Number\(d\.summary\.platformGrossProfit\) \|\| 0\)/);
  assert.match(owner, /fetch\('\/api\/owner\/financial-dashboard\?period=all&ledger=all'/);
  assert.match(read('api/owner/financial-dashboard.js'), /const ledgerLimit = String\(req\.query\.ledger \|\| ''\) === 'all' \? Infinity : 100;/);
}
console.log('PASS money: the Bookings tile, Customers and the Financial Report all read Financials');

// The App Review demo account was counted as a free Easer, an active Easer, and
// toward the 10-Easer expansion check.
{
  assert.match(read('api/owner/live-ops.js'), /const rosterEasers = easers\.filter\(e => e\.readiness\?\.ownerApproved && e\.readiness\?\.tierEligible && !demoEaserIds\.has\(e\.id\)\);/);
  assert.match(read('api/owner/financial-dashboard.js'), /activeEasers = \(easerProfiles \|\| \[\]\)\.filter\(profile => profile\.status === 'active' && !demoEaserIds\.has\(profile\.id\)\)\.length;/);
  const list = read('api/assembler/list.js');
  assert.match(list, /const working = assemblers\.filter\(a => !demoIds\.has\(a\.id\)\);/);
  assert.match(list, /active:\s+working\.filter\(a => a\.status === 'active'\)\.length,/);
  assert.match(owner, /a\.is_demo_account \? ' <span title="App Review demo account/);
}
console.log('PASS demo account: listed and labelled, never counted as a working Easer');

// Live Ops said "Nothing needs you right now" over two test jobs "needing action".
{
  const ops = read('api/owner/live-ops.js');
  assert.match(ops, /const bookingProjection = 'id, ref, is_test_booking, /);
  assert.match(ops, /\.filter\(b => b\.status === 'completed'\s*&& b\.is_test_booking !== true\s*&& isOwnerManualOfflineBooking\(b\)/);
}
console.log('PASS live ops: a test job never needs reconciling');

// Financials showed Travis as Professional (his level when July's jobs were
// assigned) while every other panel said Starter.
{
  const payouts = read('api/owner/payouts.js');
  assert.match(payouts, /\.select\('id, email, phone, tier, /);
  assert.match(payouts, /if \(profile\.tier\) easer\.assembler_tier = profile\.tier;/);
}
console.log('PASS payouts: the Easer level shown is today\'s');

// Today counted cancelled and test bookings, and its badge was blank until the
// view was opened; the open view never updated.
{
  const ctx = {
    PIPELINE_STATUSES: ['en_route', 'arrived', 'in_progress'],
    realBookings: () => [
      { status: 'confirmed', date: '2026-11-10' },
      { status: 'cancelled', date: '2026-11-10' },
      { status: 'declined', date: '2026-11-10' },
      { status: 'completed', date: '2026-11-10' },
      { status: 'confirmed', date: '2026-11-11' },
      { status: 'completed', date: '2026-11-01', return_visit_date: '2026-11-10', return_visit_required: true },
    ],
  };
  vm.runInNewContext(`var TODAY_EXCLUDED_STATUSES = ['cancelled', 'declined', 'refunded'];\n${fnSource('todayUsesReturnVisit')}\n${fnSource('todayScheduleJobs')}\n${fnSource('todayActiveCount')}\nthis.jobs = todayScheduleJobs('2026-11-10'); this.active = todayActiveCount(this.jobs);`, ctx);
  assert.equal(ctx.jobs.length, 3, 'confirmed, completed and the return visit; not cancelled or declined');
  assert.equal(ctx.active, 1);
  assert.match(fnSource('todayScheduleJobs'), /return realBookings\(\)\.filter/, 'test bookings never count');
  assert.match(owner, /renderList\(\);\s*paintTodayBadge\(\);\s*if \(currentView === 'today'\) renderTodayView\(\);\s*else if \(currentView === 'customers'\) renderCustomers\(false\);/);
}
console.log('PASS today: real scheduled jobs only; the badge and open views follow every refresh');

// Badges loaded once at sign-in and never again.
{
  assert.match(owner, /setTimeout\(refreshNavBadges, 0\);\s*if \(_badgesTimer\) clearInterval\(_badgesTimer\);\s*_badgesTimer = setInterval\(function\(\) \{ if \(!document\.hidden\) refreshNavBadges\(\); \}, 60000\);/);
  const refresh = fnSource('refreshNavBadges');
  for (const piece of ['/api/assembler/list', '/api/owner/waitlist?status=pending', '/api/owner/market-demand', 'OwnerCases.loadBadge', 'OwnerVoiceCalls.loadBadge', 'OwnerPartners.loadBadge', 'OwnerInbox.loadBadge']) {
    assert.ok(refresh.includes(piece), piece);
  }
  assert.match(owner, /if \(_badgesTimer\) \{ clearInterval\(_badgesTimer\); _badgesTimer = null; \}/, 'stopped on sign-out');
  assert.match(read('owner/assets/messages.js'), /if \(state\.badgeError\) \{ badge\.textContent = '!';/, 'Messages says unknown, not zero');
}
console.log('PASS badges: every badge refreshes every minute, and unknown is never shown as zero');

console.log('\nOwner dashboard truth tests passed.');
