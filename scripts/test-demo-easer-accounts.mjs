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

console.log('demo Easer accounts: test bookings only, enforced in dispatch, assign, crew and accept');
