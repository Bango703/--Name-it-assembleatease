#!/usr/bin/env node
// A demo Easer account may only ever be given a TEST booking.
//
// Owner, 2026-10-09: Apple's App Review needs an Easer sign-in that can open
// every screen and run a whole job. The reviewer account is approved and
// identity-verified, so without this rule the moment it signed its agreement
// it would become eligible for real customer jobs, and dispatch would send a
// stranger at Apple a real customer's address. The flag
// profiles.is_demo_account (migration 106) closes that: every path that puts
// an Easer on a booking refuses a demo account unless the booking is a test
// booking (bookings.is_test_booking, migration 094).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  demoBookingBlock,
  withoutDemoEasers,
  loadDemoEaserIds,
  isDemoEaser,
} from '../api/_demo-accounts.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── The rule ────────────────────────────────────────────────────────────────
assert.equal(demoBookingBlock({ is_test_booking: false }, false), null, 'A normal Easer is never blocked');
assert.equal(demoBookingBlock({ is_test_booking: true }, true), null, 'A demo Easer may take a test booking');
for (const booking of [{ is_test_booking: false }, {}, null, { is_test_booking: 'true' }]) {
  const block = demoBookingBlock(booking, true);
  assert.equal(block?.code, 'DEMO_ACCOUNT_REAL_BOOKING', `A demo Easer must be refused a real booking (${JSON.stringify(booking)})`);
  assert.match(block.message, /demo account/i, 'The refusal states its reason (Article 14)');
}

const easers = [{ id: 'real' }, { id: 'demo' }];
const demo = new Set(['demo']);
assert.deepEqual(withoutDemoEasers(easers, demo, { is_test_booking: false }).map(e => e.id), ['real'],
  'Dispatch drops demo Easers from a real booking');
assert.deepEqual(withoutDemoEasers(easers, demo, { is_test_booking: true }).map(e => e.id), ['real', 'demo'],
  'Dispatch keeps demo Easers for a test booking');
assert.equal(withoutDemoEasers(easers, new Set(), {}), easers, 'No demo accounts means the list is untouched');

// ── Safe before the migration: a missing column means "no demo accounts" ────
function fakeSb(result) {
  const q = {
    select: () => q, eq: () => q,
    maybeSingle: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return { from: () => q };
}
const missing = { data: null, error: { code: '42703', message: 'column profiles.is_demo_account does not exist' } };
const quiet = console.error; console.error = () => {};
try {
  assert.equal((await loadDemoEaserIds(fakeSb(missing))).size, 0, 'Missing column must read as no demo accounts');
  assert.equal(await isDemoEaser(fakeSb(missing), 'x'), false, 'Missing column must read as not demo');
  assert.equal((await loadDemoEaserIds(fakeSb({ data: null, error: { message: 'timeout' } }))).size, 0, 'A failed lookup must not break dispatch');
} finally {
  console.error = quiet;
}
assert.deepEqual([...await loadDemoEaserIds(fakeSb({ data: [{ id: 'd1' }], error: null }))], ['d1']);
assert.equal(await isDemoEaser(fakeSb({ data: { is_demo_account: true }, error: null }), 'd1'), true);

// The flag is read with its own query, never added to an existing select, so a
// missing column cannot break the queries dispatch and assignment already run.
const helper = await read('api/_demo-accounts.js');
assert.match(helper, /select\('id'\)\.eq\('is_demo_account', true\)/);

// ── Every path that puts an Easer on a booking enforces it ──────────────────
const dispatch = await read('api/booking/_dispatch-internal.js');
assert.match(dispatch, /eligible = withoutDemoEasers\(eligible, demoEaserIds, booking\)/,
  'Auto-dispatch must drop demo Easers from real bookings');
assert.match(dispatch, /if \(demoEaserIds\.has\(e\.id\)\) continue;/,
  'Job nudge emails must skip demo Easers');
assert.doesNotMatch(dispatch, /select\([^)]*is_demo_account/, 'Dispatch must not add the flag to its Easer select');

const assign = await read('api/booking/assign.js');
assert.match(assign, /demoBookingBlock\(booking, await isDemoEaser\(sb, assemblerId\)\)/, 'Owner assign must refuse');

const accept = await read('api/booking/accept-dispatch.js');
assert.equal((accept.match(/demoBookingBlock\(booking, await isDemoEaser\(sb, assemblerId\)\)/g) || []).length, 2,
  'Both accept paths (offer and legacy token) must refuse');

const crew = await read('api/owner/crew.js');
assert.match(crew, /\.select\('[^']*is_test_booking'\)/, 'Crew must load the test-booking flag it decides on');
assert.match(crew, /demoBookingBlock\(booking, await isDemoEaser\(sb, easerId\)\)/, 'Adding crew must refuse');

// ── The migration ───────────────────────────────────────────────────────────
const migration = await read('api/migrations/106_demo_easer_accounts.sql');
assert.match(migration, /ADD COLUMN IF NOT EXISTS is_demo_account BOOLEAN NOT NULL DEFAULT FALSE/,
  'Every existing and new Easer is a normal Easer unless marked');
assert.match(migration, /lower\(email\) = 'service\+appreview@assembleatease\.com'/, 'Only the App Review account is marked');
assert.match(migration, /VALUES \(106, 'demo_easer_accounts'\)/);
assert.match(migration, /NOTIFY pgrst, 'reload schema'/);

// Easers cannot unmark themselves: the self-update guard is an allowlist.
const hardening = await read('api/migrations/031_security_privilege_hardening.sql');
const allowed = hardening.match(/v_allowed_keys CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)?.[1] || '';
assert.ok(allowed && !/is_demo_account/.test(allowed), 'is_demo_account must never be Easer-editable');

// ── A demo account can run a whole TEST job (migration 107) ─────────────────
// App Review must be able to accept, travel, arrive, start and complete. The
// only booking with no customer card is an owner-created offline booking, so a
// demo Easer on an offline TEST booking gets the owner-Easer's exception, and
// nothing else does.
const { isDemoTestLiveFlow, isOfflineLiveFlow } = await import('../api/_owner-easer.js');
let lookups = 0;
const demoSb = flag => ({ from: () => { lookups++; const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { is_demo_account: flag }, error: null }) }; return q; } });
const offlineTest = { source: 'owner_manual', payment_status: 'offline_recorded', is_test_booking: true };
assert.equal(await isDemoTestLiveFlow(demoSb(true), offlineTest, 'd1'), true, 'demo Easer + offline test booking works the live flow');
assert.equal(await isDemoTestLiveFlow(demoSb(false), offlineTest, 'e1'), false, 'a normal Easer never gets the exception');
lookups = 0;
for (const booking of [
  { ...offlineTest, is_test_booking: false },
  { ...offlineTest, payment_status: 'authorized' },
  { ...offlineTest, source: 'online' },
]) {
  assert.equal(await isDemoTestLiveFlow(demoSb(true), booking, 'd1'), false, `no exception for ${JSON.stringify(booking)}`);
}
assert.equal(lookups, 0, 'real bookings never even look the flag up');
assert.equal(await isOfflineLiveFlow(demoSb(false), { source: 'owner_manual', payment_status: 'offline_recorded' }, { id: 'o', is_owner: true, role: 'assembler' }), true,
  'the owner-Easer exception is unchanged');

assert.match(assign, /ownerManualConfirmed\s*&& \(ownerEaserManual \|\| await isDemoTestLiveFlow\(sb, booking, assemblerId\)\)/, 'assign: demo on offline test booking skips the card gate only');
assert.match(assign, /if \(recordOnlyOwnerManualCompleted && !ownerEaserManual\)/, 'crediting completed offline work stays owner-only');
assert.match(accept, /await isOfflineLiveFlow\(sb, booking, actorProfile\)/, 'accept uses the shared rule');
const status = await read('api/booking/easer-status.js');
assert.match(status, /await isOfflineLiveFlow\(sb, booking, profile\)/, 'on the way / arrived / start use the shared rule');
const complete = await read('api/booking/assembler-complete.js');
assert.match(complete, /payout_status: split\.assemblerDueCents > 0 && !demoTestJob \? 'pending' : null/, 'a demo test job owes no payout');
assert.match(complete, /payout_mode_snapshot: split\.assemblerDueCents > 0 && !demoTestJob \? 'manual' : null/);
const payouts = await read('api/owner/payouts.js');
assert.match(payouts, /r\.assemblerId && r\.isTestBooking !== true/, 'test bookings never appear as money owed');
const myAssignments = await read('api/booking/my-assignments.js');
assert.match(myAssignments, /same_day_easer_bonus_cents, is_test_booking'\)/, 'the job list loads the test flag it decides on');
const markTest = await read('api/owner/mark-test-booking.js');
assert.match(markTest, /!isTest && booking\.assembler_id && await isDemoEaser\(sb, booking\.assembler_id\)/, 'a demo-held test booking cannot be turned real');
const assemblersApi = await read('api/booking/assemblers.js');
assert.match(assemblersApi, /is_demo_account: demoIds\.has\(normalized\.id\)/, 'the dashboard is told which Easers are demo accounts');
const ownerPage = await read('owner/index.html');
assert.match(ownerPage, /a\.is_owner === true \|\| \(b\.is_test_booking === true && a\.is_demo_account === true\)/, 'dashboard offers demo accounts on offline test bookings');
assert.ok((ownerPage.match(/a\.is_demo_account !== true \|\| b\.is_test_booking === true/g) || []).length >= 2, 'dashboard never offers demo accounts on real bookings');

const m107 = await read('api/migrations/107_demo_test_job_flow.sql');
assert.match(m107, /v_demo_test_easer := COALESCE\(NEW\.source, 'online'\) = 'owner_manual'\s+AND NEW\.payment_status = 'offline_recorded'\s+AND COALESCE\(NEW\.is_test_booking, FALSE\) = TRUE\s+AND COALESCE\(v_profile\.is_demo_account, FALSE\) = TRUE;/);
assert.match(m107, /AND NOT v_record_only_owner_manual AND NOT v_owner_manual_easer AND NOT v_demo_test_easer;/, 'only the payment gate is relaxed');
assert.match(m107, /RAISE EXCEPTION 'A demo account can only be given test bookings'/, 'the database refuses a demo account on a real booking');
assert.match(m107, /public\.current_required_agreement_version\(\)/, 'agreement version still read from its single source');
assert.match(m107, /VALUES \(107, 'demo_test_job_flow'\)/);

// The owner can mark an OFFLINE booking as a test: the offline action list
// returned before the toggle, so the demo job could never be set up.
assert.equal((ownerPage.match(/pushTestBookingToggle\(b, notices, btns\);/g) || []).length, 2, 'test toggle on online and offline bookings');
// A blank email failed as "Failed to save the booking" (the column is NOT NULL).
assert.match(await read('api/owner/create-booking.js'), /if \(!cleanEmail\) \{\s*return res\.status\(400\)\.json\(\{ error: 'Customer email is required\.'/);

// A demo account is paid nothing, so it never reaches live Stripe payout setup,
// which verifies a real person and bank (owner question, 2026-10-10).
assert.match(await read('api/_announcements.js'), /if \(demo && a\.target_rule === 'payout_setup_incomplete'\) continue;/, 'no "Set up payouts" action for a demo account');
assert.match(await read('api/cron/easer-announcements.js'), /if \(demoIds\.has\(easer\.id\)\) continue;/, 'no payout setup reminders to a demo account');
assert.match(await read('api/assembler/connect-link.js'), /if \(await isDemoEaser\(sb, user\.id\)\) \{\s*return res\.status\(403\)/, 'the payout setup link refuses a demo account');

console.log('demo Easer accounts: test bookings only, enforced in dispatch, assign, crew, accept and the database; a demo can run a whole test job with no payout');
