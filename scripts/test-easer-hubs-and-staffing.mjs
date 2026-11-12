#!/usr/bin/env node
// Owner, 2026-11-11: "I need real Easers in the Texas major hubs." Three parts:
//   1. No Easer application fee in a hub until it has six active Easers.
//   2. Before booking, the customer is told when no active Easer covers their ZIP.
//   3. A booking nobody has accepted reaches the owner three hours after it was
//      made, not six hours before the appointment.
// Production data that day: 10 of 21 bookings cancelled, 6 of the 7 real
// cancellations never had an Easer accept, 9 active Easers in 8 cities.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marketForZip, SERVICE_MARKETS, isSameServiceMarket } from '../api/_source-of-truth.js';
import { sameCoverageArea, easersCovering, activeEaserZips, UNCOVERED_AREA_NOTE } from '../api/_easer-coverage.js';
import { applicationFeeDecision, easerFeeHubForZip, EASER_FEE_HUBS, FREE_UNTIL_ACTIVE_EASERS_PER_HUB } from '../api/_easer-application-fee.js';
import coverageHandler from '../api/booking/area-coverage.js';
import { earlyAlertDue } from '../api/cron/unassigned-escalation.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Dallas-Fort Worth is a market: dispatch, reporting and the fee all see it.
{
  assert.deepEqual([...SERVICE_MARKETS.dallas_fort_worth], ['750', '751', '752', '753', '754', '760', '761', '762']);
  for (const zip of ['75227', '75409', '76102', '76010', '76201']) assert.equal(marketForZip(zip), 'dallas_fort_worth', zip);
  assert.equal(marketForZip('75701'), null, 'Tyler has no market yet');
  assert.equal(isSameServiceMarket('78701', '75227'), false, 'a Dallas Easer is no longer offered Austin jobs');
  assert.equal(isSameServiceMarket('76102', '75227'), true, 'Fort Worth and Dallas share Easers');
  assert.match(read('api/_market-area.js'), /dallas_fort_worth: \{ city: 'Dallas', label: 'Dallas-Fort Worth area' \}/);
}
console.log('PASS Dallas-Fort Worth is a service market');

// 1. The fee: per hub, six active Easers, free outside the hubs.
{
  assert.deepEqual([...EASER_FEE_HUBS], ['central_texas', 'houston', 'san_antonio', 'dallas_fort_worth']);
  assert.equal(FREE_UNTIL_ACTIVE_EASERS_PER_HUB, 6);
  assert.equal(easerFeeHubForZip('78660'), 'central_texas');
  assert.equal(easerFeeHubForZip('79413'), null, 'Lubbock is a market but not a fee hub');
  const today = { central_texas: 1, houston: 1, san_antonio: 2, dallas_fort_worth: 2 };
  for (const zip of ['78701', '77002', '78240', '75227', '75701', '79413']) {
    assert.equal(applicationFeeDecision({ zip, activeByHub: today }).waived, true, `no fee today at ${zip}`);
  }
  const austinFull = { ...today, central_texas: 6 };
  assert.equal(applicationFeeDecision({ zip: '78745', activeByHub: austinFull }).waived, false, 'Austin at six: the fee applies');
  assert.equal(applicationFeeDecision({ zip: '77002', activeByHub: austinFull }).waived, true, 'Houston still free');
  assert.equal(applicationFeeDecision({ zip: '', activeByHub: austinFull }).waived, false, 'no ZIP: no promise once any hub charges');
  const apply = read('api/assembler/apply.js');
  assert.match(apply, /claimFoundingEaserApplicationStatus\(sb, userId, \{ zip: cleanZip \}\)/);
  assert.match(apply, /claimFoundingEaserApplicationStatus\(sb, profile\.id, \{ zip: profile\.zip \}\)/);
  assert.match(read('api/assembler/application-fee-status.js'), /getEaserApplicationFeeStatus\(getSupabase\(\), \{ zip: requestedZip \}\)/);
  const page = read('assembler/apply.html');
  assert.match(page, /zipInput\.addEventListener\('change', recheck\);/, 'the fee is checked again once the ZIP is entered');
  assert.doesNotMatch(page, /Founding Easer/);
  assert.doesNotMatch(read('api/_easer-application-fee.js'), /FOUNDING_EASER_FREE_APPLICATION_LIMIT/, 'the statewide first-20 rule is gone');
}
console.log('PASS fee: free in a hub until six active Easers, free outside the hubs, checked at the applicant\'s ZIP');

// 2. Coverage before booking.
{
  assert.equal(sameCoverageArea('78701', '78660'), true, 'Austin and Pflugerville');
  assert.equal(sameCoverageArea('76102', '75227'), true, 'Fort Worth and Dallas');
  assert.equal(sameCoverageArea('75701', '75791'), true, 'Tyler and Whitehouse share 757 with no market');
  assert.equal(sameCoverageArea('75701', '75227'), false);
  assert.equal(sameCoverageArea('79413', '78701'), false);
  const zips = await activeEaserZips({ from: () => {
    const chain = { select: () => chain, eq: () => chain, then: (resolve) => resolve({ data: [
      { zip: '78660', is_demo_account: false }, { zip: '78701', is_demo_account: true }, { zip: null, is_demo_account: false }, { zip: '75791-1234', is_demo_account: false },
    ], error: null }) };
    return chain;
  } });
  assert.deepEqual(zips, ['78660', '75791'], 'demo account and missing ZIPs never count');
  assert.equal(easersCovering(zips, '78745'), 1);
  assert.equal(easersCovering(zips, '77002'), 0);

  const call = async (zip, sb) => {
    const res = { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const realFrom = sb;
    await coverageHandler({ method: 'GET', headers: {}, query: { zip } }, res, realFrom);
    return res;
  };
  // The handler reads the real client; exercise the parts that need none.
  const bad = await call('7870');
  assert.equal(bad.code, 400);
  assert.equal(UNCOVERED_AREA_NOTE, 'Pros are limited near this ZIP. We confirm your pro before your visit, and you pay only when the job is done.');
  assert.doesNotMatch(UNCOVERED_AREA_NOTE, /hold|authoriz|dispatch|Easer/i, 'customer words only');
  const preview = read('api/booking/promo-preview.js');
  assert.match(preview, /plan: withAreaNote\(checkoutPlan\(/, 'the app review step carries the note');
  assert.match(preview, /if \(areaCovered !== false \|\| !plan\) return plan;/, 'unknown coverage adds nothing');
  const book = read('book.html');
  assert.match(book, /checkAreaCoverage\(valid && active \? zip : ''\);/);
  assert.match(book, /fetch\('\/api\/booking\/area-coverage\?zip=' \+ encodeURIComponent\(zip\)\)/);
  assert.match(book, /if \(d\.covered === false && d\.note\) \{ el\.textContent = d\.note;/);
}
console.log('PASS coverage: one rule, the same note on the website and in the app, nothing shown on a guess');

// 3. The early owner alert.
{
  const now = Date.parse('2026-11-11T18:00:00Z');
  const booking = (createdHoursAgo, extra = {}) => ({ created_at: new Date(now - createdHoursAgo * 3600000).toISOString(), ...extra });
  assert.equal(earlyAlertDue(booking(2), now, 72), null, 'two hours old: not yet');
  assert.ok(Math.abs(earlyAlertDue(booking(3.5), now, 72) - 3.5) < 1e-9, 'three and a half hours: due');
  assert.equal(earlyAlertDue(booking(30), now, 5), null, 'inside six hours the urgent stage owns it');
  assert.equal(earlyAlertDue(booking(30, { rescheduled_at: new Date(now - 3600000).toISOString() }), now, 72), null, 'a moved booking starts its three hours again');
  assert.equal(earlyAlertDue({}, now, 72), null);
  const cron = read('api/cron/unassigned-escalation.js');
  assert.match(cron, /const EARLY_OWNER_ALERT_AFTER_HOURS = 3;/);
  assert.match(cron, /if \(!stillOpen \|\| await earlyAlertSent\(sb, b\)\) continue;/, 'once per booking, and only while still unaccepted');
  assert.match(cron, /notificationType: 'unassigned_early_owner', recipientType: 'owner'/);
  assert.ok(cron.indexOf('if (b.is_test_booking === true) continue;') < cron.indexOf('Stage 0: early'), 'test bookings never alert');
  assert.match(cron, /\.select\('id, ref, created_at, service,/);
}
console.log('PASS early alert: three hours after booking, once, never for test bookings, urgent stage unchanged');

console.log('\nEaser hubs and staffing tests passed.');
