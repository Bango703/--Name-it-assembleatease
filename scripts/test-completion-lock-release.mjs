#!/usr/bin/env node
// A failed completion must not strand the booking.
//
// WHAT HAPPENED. AAE-DVSNHXE4OO failed capture at 16:27 with "Stripe captured
// payment does not match this booking". The handler wrote the audit row, logged
// the activity, emailed the owner — and returned 502 while still holding the
// reservation it took at the top. Nothing releases a stale completion lock: no
// cron reaps it, release-payouts only DETECTS one and blocks the payout, and no
// owner screen can clear it. Every retry then returned
// FINANCIAL_OPERATION_CONFLICT, so closing the job needed a hand-written UPDATE
// against production.
//
// One recoverable error became a dead booking. Both completion paths had it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

for (const file of ['api/booking/complete.js', 'api/booking/assembler-complete.js']) {
  const src = await read(file);

  // The reservation and its release must both exist in the same file.
  assert.match(src, /reserveBookingFinancialOperation/, `${file} must take the reservation`);
  assert.match(src, /releaseBookingFinancialOperation/,
    `${file} must import and use the release helper, not hand-roll a column write`);

  // Scope to the capture-failure branch and prove the release happens BEFORE
  // the 502 leaves. A release after the return is unreachable code.
  const start = src.indexOf('} catch (stripeErr) {');
  assert.notEqual(start, -1, `${file} must still have a capture-failure branch`);
  const end = src.indexOf("code: 'CAPTURE_FAILED'", start);
  assert.notEqual(end, -1, `${file} must still return CAPTURE_FAILED`);
  const branch = src.slice(start, end);

  assert.match(branch, /releaseBookingFinancialOperation\(sb, \{ bookingId: booking\.id, operationKey \}\)/,
    `${file} must release the lock on capture failure`);

  // The release itself can fail. If it does, that fact has to be recorded,
  // because the booking is now stuck and silence is how it stays stuck.
  assert.match(branch, /completion_lock_release_failed/,
    `${file} must log when it cannot release its own lock`);

  // Releasing must not be mistaken for succeeding.
  assert.doesNotMatch(branch, /status: 'completed'|BOOKING_STATUS\.COMPLETED/,
    `${file} must not mark the booking complete on a capture failure`);
  assert.doesNotMatch(branch, /payout_status/,
    `${file} must not create earnings on a capture failure`);
}

// The release helper goes through the RPC, which checks the key matches before
// clearing. A blind column write would let one request clear another's lock.
const helper = await read('api/booking/_financial-operation.js');
assert.match(helper, /release_booking_financial_operation/,
  'release must go through the RPC that verifies the operation key');

console.log('PASS completion lock release: a failed capture frees the booking in both completion paths, and says so if it cannot');
