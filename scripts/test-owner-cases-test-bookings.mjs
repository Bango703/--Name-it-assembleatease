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

// Execute the shipped detection endpoint against an isolated read-only schema.
// A misspelled table must fail here just as it does in production; source-text
// assertions above cannot prove that the handler reads the canonical table.
const sweepSource = (await read('api/owner/test-cases.js'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default async function handler', 'async function handler');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const makeCase = (id, patch = {}) => ({ id, case_ref: `CASE-${id}`, case_type: 'support', status: 'open', severity: 'normal',
  subject: 'Please contact me', description: 'I have a question about my appointment.', booking_id: null,
  customer_name: 'Customer Person', customer_email: 'customer@example.test', created_by_name: 'Customer Person',
  created_at: '2026-09-28T12:00:00Z', ...patch });
const caseColumns = new Set(Object.keys(makeCase('schema')));
const bookingColumns = new Set(['id', 'ref', 'customer_email', 'is_test_booking']);

async function sweepFixture({ caseRows = [], bookingRows = [], failTable = null } = {}) {
  const tables = { operations_cases: structuredClone(caseRows), bookings: structuredClone(bookingRows) };
  const before = structuredClone(tables), reads = [];
  let connections = 0;
  const sb = { from(table) {
    const predicates = [];
    let columns = [], sort, max = Infinity;
    const entry = { table };
    reads.push(entry);
    const query = {
      select(value) { columns = value.split(',').map(column => column.trim()); entry.columns = columns; return query; },
      order(column, { ascending }) { sort = { column, ascending }; return query; },
      limit(value) { max = value; return query; },
      in(column, values) { entry.values = [...values]; predicates.push(row => values.includes(row[column])); return query; },
      update() { assert.fail('Test-case detection must not update any row'); },
      insert() { assert.fail('Test-case detection must not insert any row'); },
      delete() { assert.fail('Test-case detection must not delete any row'); },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (!Object.hasOwn(tables, table)) return { data: null, error: { code: '42P01', message: 'Table does not exist' } };
        const schema = table === 'operations_cases' ? caseColumns : bookingColumns;
        if (columns.some(column => !schema.has(column))) return { data: null, error: { message: 'Column does not exist' } };
        // Return data alongside the failure to prove partial reads are rejected.
        if (table === failTable) return { data: structuredClone(tables[table]), error: { message: 'Read unavailable' } };
        let rows = tables[table].filter(row => predicates.every(test => test(row)));
        if (sort) rows = [...rows].sort((a, b) => String(a[sort.column]).localeCompare(String(b[sort.column])) * (sort.ascending ? 1 : -1));
        return { data: rows.slice(0, max).map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null]))), error: null };
      }).then(resolve, reject); },
    };
    return query;
  }, rpc() { assert.fail('Test-case detection must not execute a database RPC'); } };
  const dependencies = {
    getSupabase() { connections++; return sb; },
    verifyOwner: req => req.headers.authorization === 'Bearer offline-owner',
    ownerEmail: () => ' Owner@Example.test ', console: { error() {} },
    fetch() { assert.fail('This isolated handler test must never use the network'); },
  };
  const handler = await new AsyncFunction(...Object.keys(dependencies), `${sweepSource}\nreturn handler;`)(...Object.values(dependencies));
  return { tables, before, reads, get connections() { return connections; }, async run({ method = 'GET', authorization = 'Bearer offline-owner' } = {}) {
    const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, headers: { authorization } }, response);
    assert.deepEqual(tables, before, 'every request leaves cases and bookings unchanged');
    return response;
  } };
}

const detectionCases = [
  makeCase('flagged', { booking_id: 'test-booking' }),
  makeCase('no-booking-text', { status: 'acknowledged', subject: 'Post-deploy check' }),
  makeCase('case-owner', { status: 'in_progress', customer_email: ' OWNER@example.test ' }),
  makeCase('sim-name', { status: 'waiting_customer', customer_name: 'SIM-Customer' }),
  makeCase('booking-owner', { status: 'waiting_easer', booking_id: 'owner-booking' }),
  makeCase('unflagged', { booking_id: 'real-booking' }),
  makeCase('unknown', { booking_id: 'missing-booking' }),
  makeCase('unknown-with-signal', { booking_id: 'missing-booking', subject: 'QA callback' }),
  makeCase('closed', { status: 'closed', booking_id: 'inactive-booking', subject: 'test' }),
  makeCase('resolved', { status: 'resolved', customer_email: 'owner@example.test' }),
];
const detectionBookings = [
  { id: 'test-booking', ref: 'AAE-TEST', customer_email: 'customer@example.test', is_test_booking: true },
  { id: 'real-booking', ref: 'AAE-REAL', customer_email: 'customer@example.test', is_test_booking: false },
  { id: 'owner-booking', ref: 'AAE-OWNER', customer_email: 'OWNER@example.test', is_test_booking: false },
];
{
  const f = await sweepFixture({ caseRows: detectionCases, bookingRows: detectionBookings });
  const result = await f.run();
  assert.equal(result.code, 200); assert.equal(result.body.ok, true);
  assert.equal(result.body.activeCount, 8, 'all five active statuses count, terminal cases do not');
  assert.deepEqual(new Set(result.body.suspects.map(row => row.id)), new Set(['flagged', 'no-booking-text', 'case-owner', 'sim-name', 'booking-owner', 'unknown-with-signal']));
  const found = new Map(result.body.suspects.map(row => [row.id, row]));
  assert.deepEqual(found.get('flagged').signals, ['its booking is marked as a test']);
  assert.equal(found.get('flagged').alreadyHidden, true); assert.equal(found.get('flagged').bookingRef, 'AAE-TEST');
  assert.deepEqual(found.get('no-booking-text').signals, ["text says 'post-deploy'"]);
  assert.equal(found.get('no-booking-text').bookingRef, null); assert.equal(found.get('no-booking-text').alreadyHidden, false);
  assert.deepEqual(found.get('case-owner').signals, ["raised against the owner's own email"]);
  assert.deepEqual(found.get('sim-name').signals, ['customer name starts with SIM-']);
  assert.deepEqual(found.get('booking-owner').signals, ["its booking is the owner's own email"]);
  assert.deepEqual(found.get('unknown-with-signal').signals, ["text says 'QA'"]);
  assert.equal(found.get('unknown-with-signal').alreadyHidden, false, 'a missing booking cannot establish a test flag');
  assert.equal(found.get('unknown-with-signal').bookingRef, null);
  assert.match(result.body.caveat, /suspected.*not confirmed/);
  assert.deepEqual(f.reads.map(query => query.table), ['operations_cases', 'bookings']);
  assert.deepEqual(new Set(f.reads[1].values), new Set(['test-booking', 'owner-booking', 'real-booking', 'missing-booking']));
  assert.equal(f.reads[1].values.length, 4, 'only distinct active linked bookings are queried');
}

for (const caseRows of [[], [makeCase('ordinary')], [makeCase('closed-only', { status: 'closed', subject: 'test' })]]) {
  const f = await sweepFixture({ caseRows }); const result = await f.run();
  assert.equal(result.code, 200); assert.deepEqual(result.body.suspects, []);
  assert.equal(result.body.activeCount, caseRows.some(row => row.status === 'open') ? 1 : 0);
  assert.deepEqual(f.reads.map(query => query.table), ['operations_cases'], 'no linked IDs means no booking read');
}
{
  const f = await sweepFixture({ caseRows: [makeCase('unknown-only', { booking_id: 'not-found' })] });
  const result = await f.run();
  assert.equal(result.code, 200); assert.equal(result.body.activeCount, 1); assert.deepEqual(result.body.suspects, []);
}
for (const options of [{ authorization: '' }, { authorization: 'Bearer customer-token' }, { method: 'POST' }, { method: 'DELETE' }]) {
  const f = await sweepFixture({ caseRows: detectionCases });
  const result = await f.run(options);
  assert.equal(result.code, options.method ? 405 : 401);
  assert.equal(f.connections, 0); assert.deepEqual(f.reads, [], 'method/auth rejection precedes all reads');
}
for (const [failTable, message] of [
  ['operations_cases', 'Cases could not be read.'],
  ['bookings', 'Linked bookings could not be checked. Try again.'],
]) {
  const f = await sweepFixture({ caseRows: detectionCases, bookingRows: detectionBookings, failTable });
  const result = await f.run();
  assert.equal(result.code, 503); assert.equal(result.body.error, message);
  assert.equal(result.body.suspects, undefined, 'failed source cannot return a partial successful suspect list');
  assert.equal(result.body.activeCount, undefined);
  assert.equal(f.reads.length, failTable === 'operations_cases' ? 1 : 2);
}

console.log('PASS actual test-case handler: canonical schema, active suspects and reasons, read-only safety, owner auth, and honest source failures');
