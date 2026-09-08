#!/usr/bin/env node
// Bookings nobody is working on must be visible.
//
// THE INCIDENT. On 2026-08-18 the same customer submitted three outdoor/playset
// bookings at $329.08 each, four minutes apart — the shape of someone retrying
// because nothing is happening. All three sat at dispatch_status `payment_hold`,
// were never offered to any Easer, and were cancelled four days later. On
// 2026-08-27 a $243.13 fitness booking reached `manual_required`, was never
// assigned, and the customer cancelled it himself the next day.
//
// WHY NOTHING CAUGHT IT. Every cron that hunts stranded work filters
// `status = 'confirmed'`: auto-dispatch, expire-offers, unassigned-escalation,
// stale-booking, reminders, no-show-check, reauth-payments. A booking whose
// payment does not complete stays `pending` and is outside all of them. The one
// cron reading `pending` is stripe-reconciliation, which compares money against
// Stripe and has no opinion about whether anyone is doing the work.
//
// The rule therefore catches by DEFAULT. Naming the states to alert on is what
// created the gap; a state nobody has thought of yet must land in the net, not
// fall through it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  isStranded,
  strandedReason,
  WATCHED_ELSEWHERE,
  STRANDED_AFTER_MINUTES,
} from '../api/_stranded-bookings-core.js';
import { TERMINAL_BOOKING_STATUSES } from '../api/_source-of-truth.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const OLD = '2026-09-08T10:00:00.000Z';    // 2 hours old
const RECENT = '2026-09-08T11:50:00.000Z'; // 10 minutes old

// ------------------------------------------------------- the actual incident --
const stephanie = {
  status: 'pending',
  created_at: OLD,
  assembler_id: null,
  payment_status: 'authorization_released',
  dispatch_status: 'payment_hold',
};
assert.equal(isStranded(stephanie, { now: NOW }), true,
  'The August 18 bookings must be caught — this is the whole point');
assert.match(strandedReason(stephanie), /payment/i,
  'The owner must be told WHY, not just that something is wrong');

const geoffrey = {
  status: 'pending',
  created_at: OLD,
  assembler_id: null,
  needs_manual_dispatch: true,
  dispatch_status: 'manual_required',
};
assert.equal(isStranded(geoffrey, { now: NOW }), true);
assert.match(strandedReason(geoffrey), /manual/i);

// --------------------------------------------------------------- not stranded --
assert.equal(isStranded({ status: 'pending', created_at: RECENT, assembler_id: null }, { now: NOW }), false,
  'A booking still inside the dispatch window is not stranded');
assert.equal(isStranded({ status: 'pending', created_at: OLD, assembler_id: 'someone' }, { now: NOW }), false,
  'Someone has it');

for (const terminal of TERMINAL_BOOKING_STATUSES) {
  assert.equal(isStranded({ status: terminal, created_at: OLD, assembler_id: null }, { now: NOW }), false,
    `${terminal} is finished; nothing is owed`);
}

// Not double-alerting on work another cron already chases.
for (const owned of WATCHED_ELSEWHERE) {
  assert.equal(isStranded({ status: owned, created_at: OLD, assembler_id: null }, { now: NOW }), false,
    `${owned} belongs to unassigned-escalation / auto-dispatch`);
}

// ------------------------------------------------------------ catch by default --
assert.equal(
  isStranded({ status: 'awaiting_parts', created_at: OLD, assembler_id: null }, { now: NOW }),
  true,
  'A status nobody has invented yet must be CAUGHT, not ignored — naming states '
  + 'is exactly what let pending fall through every cron for four months',
);

// ------------------------------------------------------------------- the cron --
const cron = await read('api/cron/stranded-booking-alert.js');
assert.match(cron, /CRON_SECRET/, 'The cron must be authenticated');
assert.doesNotMatch(cron, /\.from\('bookings'\)[\s\S]{0,200}\.(update|insert|delete)\(/,
  'Detection must never mutate a booking');
assert.match(cron, /operational_events/, 'Alerts must be recorded');
// Recorded only after a successful send, so a failed email retries next run.
const recordIndex = cron.indexOf("from('operational_events').insert");
const sendIndex = cron.indexOf('sendEmail(');
assert.ok(sendIndex >= 0 && recordIndex > sendIndex,
  'The event must be recorded AFTER the email, or a failed send is remembered as reported');

// The resurface lookup has to read the same column the insert writes, or every
// alert repeats forever.
assert.match(cron, /\.select\('payload, created_at'\)/);
assert.match(cron, /e\?\.payload\?\.refs/);

const vercel = JSON.parse(await read('vercel.json'));
const entry = (vercel.crons || []).find(c => c.path === '/api/cron/stranded-booking-alert');
assert.ok(entry, 'The cron must be registered in vercel.json or it never runs');
assert.ok(entry.schedule, 'The cron needs a schedule');

assert.ok(STRANDED_AFTER_MINUTES >= 30 && STRANDED_AFTER_MINUTES <= 120,
  'Threshold must be past normal dispatch but well inside a customer giving up');

console.log('PASS stranded bookings: incident cases caught, terminal/owned states excluded, '
  + 'unknown states caught by default, cron authenticated, read-only and registered');
