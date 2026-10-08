#!/usr/bin/env node
// A card hold must outlive the job it is holding money for.
//
// THE INCIDENT THESE NUMBERS CAUSED
// AAE-DVSNHXE4OO was booked 2026-09-19 for 2026-09-24. Five days out, which
// was inside IMMEDIATE_AUTHORIZATION_DAYS (6), so it authorized on the spot
// and never went near the scheduled cron. The card was a Visa, whose
// merchant-initiated window is 4 days 18 hours, so the hold died on the 23rd.
// The Easer worked the 24th, pressed complete, and capture failed on a
// finished job. The customer then spent two days being told her payment links
// had expired.
//
// This file exists so that arithmetic can never be wrong again. It does not
// assert "the number is 3" — it asserts the number SURVIVES THE WORST CARD.
// Raise the lead time and this fails with the margin it would have lost.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  IMMEDIATE_AUTHORIZATION_DAYS,
  SCHEDULED_AUTHORIZATION_LEAD_DAYS,
  needsScheduledAuthorization,
  scheduledAuthorizationDate,
} from '../api/booking/_booking-window.js';
import { EXPECTED_COMPLETION_BUFFER_HOURS } from '../api/booking/_authorization-window.js';


// Stripe's shortest window, and the only one that matters: we cannot choose
// the customer's card brand, so every lead time must survive this one.
const VISA_MIT_HOURS = 4 * 24 + 18;   // 114
// The cron runs 10:15 UTC daily, so a late appointment can be authorized
// almost a full extra day ahead of its own start time.
const CRON_LAG_HOURS = 13;
// A long job still has to finish inside the hold.
const JOB_HOURS = 12;

function worstCaseHoursNeeded(leadDays) {
  return leadDays * 24 + CRON_LAG_HOURS + JOB_HOURS + EXPECTED_COMPLETION_BUFFER_HOURS;
}

// ── 1. The hold outlives the job on the worst card ──────────────────────────
for (const [label, leadDays] of [
  ['scheduled', SCHEDULED_AUTHORIZATION_LEAD_DAYS],
  ['immediate', IMMEDIATE_AUTHORIZATION_DAYS],
]) {
  const needed = worstCaseHoursNeeded(leadDays);
  assert.ok(needed <= VISA_MIT_HOURS,
    `${label} lead of ${leadDays} days needs ${needed}h of authorization but a Visa merchant-initiated hold only lasts ${VISA_MIT_HOURS}h — it would die ${needed - VISA_MIT_HOURS}h before the job could be captured`);
}

// The old values, proven to fail, so nobody restores them by "tidying".
assert.ok(worstCaseHoursNeeded(5) > VISA_MIT_HOURS, 'a 5-day lead must remain impossible');
assert.ok(worstCaseHoursNeeded(6) > VISA_MIT_HOURS, 'a 6-day lead must remain impossible');
assert.ok(worstCaseHoursNeeded(4) > VISA_MIT_HOURS, 'even 4 days leaves no usable margin');
assert.ok(VISA_MIT_HOURS - worstCaseHoursNeeded(SCHEDULED_AUTHORIZATION_LEAD_DAYS) >= 24,
  'a margin under a day is one slow cron or one long job away from the incident');

// ── 2. The two constants must stay equal ────────────────────────────────────
// IMMEDIATE decides what SKIPS the cron. Larger than the scheduled lead and
// bookings inside the gap take an immediate hold that the scheduled path was
// changed to prevent — which is precisely how the incident happened.
assert.equal(IMMEDIATE_AUTHORIZATION_DAYS, SCHEDULED_AUTHORIZATION_LEAD_DAYS,
  'a booking must never be authorized earlier by booking sooner');

// ── 3. And enough runway to rescue a dead card ──────────────────────────────
// Too short is its own failure: the card declines the night before and the
// Easer is already scheduled.
assert.ok(SCHEDULED_AUTHORIZATION_LEAD_DAYS >= 2,
  'a failed card needs to surface with time to contact the customer');

// ── 4. The incident, replayed against the new numbers ───────────────────────
const bookedOn = new Date('2026-09-19T20:00:00Z');
assert.equal(needsScheduledAuthorization('2026-09-24', bookedOn), true,
  'the Sep 19 booking for Sep 24 must now WAIT for the cron instead of authorizing on the spot');
assert.equal(scheduledAuthorizationDate('2026-09-24'), '2026-09-22',
  'and the hold is taken two days out, well inside the Visa window');

// Same-day and next-day work still authorizes immediately; there is no gap
// where a booking is too close for the cron and too far for immediate.
assert.equal(needsScheduledAuthorization('2026-09-20', bookedOn), false,
  'a booking inside the lead time authorizes now, because the cron would be too late');

// ── 5. The browser mirror agrees ────────────────────────────────────────────
// book.html decides whether to take a card at checkout. If it disagrees with
// the server, a customer is charged on a schedule the server does not expect.
const book = await readFile(new URL('../book.html', import.meta.url), 'utf8');
const mirrored = book.match(/var IMMEDIATE_AUTHORIZATION_DAYS = (\d+);/);
assert.ok(mirrored, 'book.html must still declare the constant');
assert.equal(Number(mirrored[1]), IMMEDIATE_AUTHORIZATION_DAYS,
  'book.html and the server must agree on when a card is taken');

console.log(`PASS authorization lead time: ${SCHEDULED_AUTHORIZATION_LEAD_DAYS} days needs ${worstCaseHoursNeeded(SCHEDULED_AUTHORIZATION_LEAD_DAYS)}h and the worst card gives ${VISA_MIT_HOURS}h — ${VISA_MIT_HOURS - worstCaseHoursNeeded(SCHEDULED_AUTHORIZATION_LEAD_DAYS)}h of margin`);
