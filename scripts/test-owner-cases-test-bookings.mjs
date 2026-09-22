import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  formatOperationCase,
  summarizeOperationCases,
  visibleOperationCases,
} from '../api/owner/cases.js';

// Cases raised against the owner's own test bookings used to sit in the owner
// Cases view, and in its counts and nav badge, alongside real customer cases.
// They are now hidden by default, the list says how many, and the owner can
// still show them.

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

const bookingMap = new Map([
  ['real-booking', { id: 'real-booking', ref: 'AAE-REAL', isTest: false }],
  ['test-booking', { id: 'test-booking', ref: 'AAE-TEST', isTest: true }],
]);
const cases = [
  { id: 'c1', case_ref: 'CASE-REAL-1', status: 'open', booking_id: 'real-booking' },
  { id: 'c2', case_ref: 'CASE-TEST-1', status: 'open', booking_id: 'test-booking' },
  { id: 'c3', case_ref: 'CASE-TEST-2', status: 'open', booking_id: 'test-booking' },
  { id: 'c4', case_ref: 'CASE-NOBOOK', status: 'open', booking_id: null },
  { id: 'c5', case_ref: 'CASE-UNKNOWN', status: 'open', booking_id: 'booking-not-in-map' },
];

// ── Hidden by default ───────────────────────────────────────────────────────
const byDefault = visibleOperationCases(cases, bookingMap);
assert.deepEqual(byDefault.visible.map(c => c.case_ref), ['CASE-REAL-1', 'CASE-NOBOOK', 'CASE-UNKNOWN']);
assert.equal(byDefault.hiddenTestCases, 2);

// A case with no booking, or whose booking could not be loaded, is never hidden:
// only the platform's own test flag hides anything.
assert.ok(byDefault.visible.some(c => c.case_ref === 'CASE-NOBOOK'), 'a case with no booking stays visible');
assert.ok(byDefault.visible.some(c => c.case_ref === 'CASE-UNKNOWN'), 'an unresolved booking never hides a case');

// A failed booking lookup returns an empty map -- nothing may vanish.
const lookupFailed = visibleOperationCases(cases, new Map());
assert.equal(lookupFailed.visible.length, cases.length, 'a failed lookup must hide nothing');
assert.equal(lookupFailed.hiddenTestCases, 0);

// ── The owner can still see them ────────────────────────────────────────────
const included = visibleOperationCases(cases, bookingMap, { includeTest: true });
assert.equal(included.visible.length, cases.length);
assert.equal(included.hiddenTestCases, 0);

// ── Counts match the list ──────────────────────────────────────────────────
// The nav badge and stat tiles read the summary. Counting hidden cases would
// print "5 active" above a list of three.
assert.equal(summarizeOperationCases(byDefault.visible).active, byDefault.visible.length);

const api = await read('api/owner/cases.js');
assert.match(api, /damage_review_status, is_test_booking'\)/, 'the booking lookup must read the test flag');
assert.match(api, /isTest: row\.is_test_booking === true/);
assert.match(api, /summary: summarizeOperationCases\(visibleCases\)/,
  'the summary must be computed from the visible cases, not all cases');
assert.doesNotMatch(api, /summary: summarizeOperationCases\(allCases\)/);
assert.match(api, /hiddenTestCases,/, 'the response must say how many cases were hidden');
assert.match(api, /includeTest = \['1', 'true', 'yes'\]\.includes\(normalize\(query\.includeTest\)\)/);

// The test flag reaches the dashboard, so a shown test case can be labelled.
const formatted = formatOperationCase(
  { id: 'c2', case_ref: 'CASE-TEST-1', case_type: 'support', status: 'open', severity: 'normal', booking_id: 'test-booking' },
  { booking: bookingMap.get('test-booking') },
);
assert.equal(formatted.booking.isTest, true);

// ── The dashboard says what it hid and offers a way back ──────────────────
const ui = await read('owner/assets/cases.js');
assert.match(ui, /from test bookings hidden\./, 'the list must say cases are hidden (Article 16)');
assert.match(ui, /data-cases-test-toggle="show"/);
assert.match(ui, /data-cases-test-toggle="hide"/);
assert.match(ui, /if \(state\.includeTest\) params\.set\('includeTest', '1'\);/);
assert.match(ui, /state\.hiddenTestCases = Number\(data\.hiddenTestCases \|\| 0\);/);
assert.match(ui, /item\.booking && item\.booking\.isTest \? '<span class="cases-badge cases-badge-test">Test<\/span>'/);
// The note must also appear when every remaining case was a test case.
assert.match(ui, /No cases match these filters\.<\/div>' \+ testNote/);

const css = await read('owner/assets/cases.css');
for (const selector of ['.cases-test-note', '.cases-test-toggle', '.cases-test-toggle:focus-visible', '.cases-badge.cases-badge-test']) {
  assert.ok(css.includes(selector + ' {'), `${selector} must be styled`);
}

console.log('owner cases test-booking visibility tests: PASS');

// ── Test cases with no booking had nowhere to inherit a flag from ──────────
// visibleOperationCases hides a case when ITS BOOKING is flagged. A case with
// booking_id = null — a support request, a voice callback, a contact form fired
// during testing — has no booking, so it stayed in the owner's queue for good.
{
  const sweep = await readFile(new URL('../api/owner/test-cases.js', import.meta.url), 'utf8');
  assert.match(sweep, /verifyOwner\(req\)/, 'owner only');
  assert.match(sweep, /req\.method !== 'GET'/, 'detection must be read-only — it closes nothing');
  assert.doesNotMatch(sweep, /\.update\(|\.delete\(/,
    'this endpoint must never mutate; closing goes through the audited case-action path');
  assert.match(sweep, /signals\.push/,
    'every suspect must carry the reason it is suspected');
  assert.match(sweep, /caveat:/,
    'the owner is about to close in bulk and must be told these are suspected, not confirmed');

  const ui = await readFile(new URL('../owner/assets/cases.js', import.meta.url), 'utf8');
  assert.match(ui, /api\/owner\/case-action/,
    'the sweep must close through case-action, keeping expectedStatus, confirmation and audit');
  assert.match(ui, /expectedStatus: box\.getAttribute\('data-sweep-status'\)/,
    'each close must carry the status it expects, so a case that moved is not clobbered');
  assert.match(ui, /checked data-sweep-id/,
    'suspects are ticked by default but every one can be unticked before closing');
  assert.match(ui, /can be reopened/,
    'the confirmation must say the cases are recoverable');
}

console.log('PASS test cases without a booking can be found and closed, with reasons shown');
