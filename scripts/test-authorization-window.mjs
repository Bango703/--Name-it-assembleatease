#!/usr/bin/env node
// AAE cannot silently arrive at job completion with an expired authorization.
//
// THE REAL INCIDENT, REPRODUCED
// AAE-DVSNHXE4OO was booked 2026-09-19 for 2026-09-24 and authorized on the
// spot, because IMMEDIATE_AUTHORIZATION_DAYS is 6 and the job was 5 days out.
// That rule assumes a 7-day hold. Stripe's window for a Visa MERCHANT-initiated
// authorization is 4 days and 18 hours, so the money stopped being capturable
// on 2026-09-23. The Easer worked on the 24th, pressed complete, and capture
// failed on a finished job.
//
// Windows, from Stripe's own table:
//   Visa MIT ....... 4 days 18 hours
//   Visa CIT ....... 7 days
//   MC/Amex/Disc ... 7 days
// We do not infer which applies. Stripe reports the answer per charge in
// charge.payment_method_details.card.capture_before and we store that.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluateAuthorizationWindow,
  needsAuthorizationRenewal,
  authorizationReadinessLabel,
  captureBeforeFromIntent,
  captureDeadlineMs,
  expectedCompletionMs,
  AUTHORIZATION_WINDOW,
  RENEWAL_LEAD_HOURS,
  EXPECTED_COMPLETION_BUFFER_HOURS,
} from '../api/booking/_authorization-window.js';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const HOUR = 3600000;
const iso = s => new Date(s).toISOString();

// The booking as it actually was.
const incident = extra => ({
  ref: 'AAE-DVSNHXE4OO',
  status: 'confirmed',
  payment_status: 'authorized',
  date: '2026-09-24',
  time: '8:00 AM - 10:00 AM',
  // Authorized 2026-09-19 on a Visa MIT: 4 days 18 hours later.
  authorization_capture_before: iso('2026-09-23T18:00:00Z'),
  ...extra,
});

// ── 1. The incident is caught, days before anyone is on site ────────────────
const onBookingDay = Date.parse('2026-09-19T20:00:00Z');
const atBooking = evaluateAuthorizationWindow(incident(), onBookingDay);
assert.equal(atBooking.ok, false, 'the Sep 19 booking must be flagged on the day it is taken');
assert.equal(atBooking.reason, AUTHORIZATION_WINDOW.EXPIRES_BEFORE_COMPLETION);
assert.ok(needsAuthorizationRenewal(incident(), onBookingDay),
  'and the monitor must want to act on it immediately, not on the morning of the job');

// Five days of runway to fix it before the Easer travels.
const hoursOfWarning = (Date.parse('2026-09-24T08:00:00Z') - onBookingDay) / HOUR;
assert.ok(hoursOfWarning > 100, `only ${hoursOfWarning}h of warning — the point is to catch it early`);

// ── 2. The same booking on a 7-day card is fine, and must not be nagged ─────
// Mastercard, or Visa customer-initiated: authorized Sep 19, good to Sep 26.
const sevenDay = incident({ authorization_capture_before: iso('2026-09-26T20:00:00Z') });
const healthy = evaluateAuthorizationWindow(sevenDay, onBookingDay);
assert.equal(healthy.ok, true, 'a 7-day hold covers a Sep 24 job booked on Sep 19');
assert.equal(healthy.reason, AUTHORIZATION_WINDOW.OK);
assert.equal(needsAuthorizationRenewal(sevenDay, onBookingDay), false,
  'and must not be renewed five days early — that is a needless charge attempt');

// ── 3. Unknown is not "fine" ────────────────────────────────────────────────
// Every booking authorized before the deadline column existed has no value.
// Treating absence as safe is the assumption that caused the incident.
const noDeadline = incident({ authorization_capture_before: null });
assert.equal(evaluateAuthorizationWindow(noDeadline, onBookingDay).ok, false,
  'an unrecorded deadline cannot be vouched for');
assert.equal(evaluateAuthorizationWindow(noDeadline, onBookingDay).reason,
  AUTHORIZATION_WINDOW.DEADLINE_UNKNOWN);
assert.ok(needsAuthorizationRenewal(noDeadline, onBookingDay),
  'and must be renewed so it becomes known');

// ── 4. The states the readiness verdict has to separate ─────────────────────
const expired = incident({ authorization_capture_before: iso('2026-09-22T00:00:00Z') });
assert.equal(evaluateAuthorizationWindow(expired, Date.parse('2026-09-23T00:00:00Z')).reason,
  AUTHORIZATION_WINDOW.ALREADY_EXPIRED);
assert.equal(evaluateAuthorizationWindow(incident({ payment_status: 'card_saved' }), onBookingDay).reason,
  AUTHORIZATION_WINDOW.NOT_AUTHORIZED);
assert.equal(evaluateAuthorizationWindow(incident({ time: 'whenever' }), onBookingDay).reason,
  AUTHORIZATION_WINDOW.APPOINTMENT_UNREADABLE,
  'an unreadable slot is not assumed to be early in the day');
assert.equal(needsAuthorizationRenewal(incident({ payment_status: 'captured' }), onBookingDay), false,
  'money already taken needs no renewal');

// ── 5. Completion is judged past the end of the slot ────────────────────────
// A hold that dies at 9am on the day of an 8am-10am job does not cover it.
const diesMidJob = incident({
  date: '2026-09-24', time: '8:00 AM - 10:00 AM',
  authorization_capture_before: iso('2026-09-24T14:00:00Z'),
});
assert.equal(evaluateAuthorizationWindow(diesMidJob, Date.parse('2026-09-20T00:00:00Z')).ok, false,
  'a job that runs long must still be capturable');
assert.equal(EXPECTED_COMPLETION_BUFFER_HOURS >= 6,
  true, 'the buffer must allow for a job overrunning its slot');
assert.ok(expectedCompletionMs(incident()) > Date.parse('2026-09-24T08:00:00Z'),
  'expected completion is after the slot opens, not at it');

// A return visit moves the money, so it moves the deadline that matters.
const returnVisit = incident({
  return_visit_required: true, return_visit_date: '2026-10-08', return_visit_time: '9:00 AM - 11:00 AM',
});
assert.ok(expectedCompletionMs(returnVisit) > Date.parse('2026-10-08T00:00:00Z'),
  'an open return visit is when the work finishes and when capture happens');

// ── 6. The renewal lead time actually leads ─────────────────────────────────
const deadline = Date.parse('2026-09-26T20:00:00Z');
const justInside = deadline - (RENEWAL_LEAD_HOURS - 1) * HOUR;
const justOutside = deadline - (RENEWAL_LEAD_HOURS + 1) * HOUR;
assert.equal(needsAuthorizationRenewal(sevenDay, justInside), true, 'inside the lead time, act');
assert.equal(needsAuthorizationRenewal(sevenDay, justOutside), false, 'outside it, leave it alone');
assert.ok(RENEWAL_LEAD_HOURS >= 24, 'a customer needs at least a day to respond to the email');

// ── 7. The deadline is read from Stripe, never computed ─────────────────────
const capture = Math.floor(Date.parse('2026-09-23T18:00:00Z') / 1000);
assert.equal(captureBeforeFromIntent({ latest_charge: { payment_method_details: { card: { capture_before: capture } } } }),
  iso('2026-09-23T18:00:00Z'), 'reads capture_before off the expanded charge');
assert.equal(captureBeforeFromIntent({ charges: { data: [{ payment_method_details: { card: { capture_before: capture } } }] } }),
  iso('2026-09-23T18:00:00Z'), 'and off the older charges list');
// A missing field yields null, never a guessed date.
assert.equal(captureBeforeFromIntent({}), null);
assert.equal(captureBeforeFromIntent({ latest_charge: 'ch_123' }), null, 'an unexpanded charge is not a deadline');
assert.equal(captureBeforeFromIntent({ latest_charge: { payment_method_details: { card: {} } } }), null);
assert.equal(captureDeadlineMs({ authorization_capture_before: 'not a date' }), null);

// ── 8. Nothing here moves money ─────────────────────────────────────────────
// This module answers a question. The canonical flow — authorize, hold, work,
// capture the existing authorization — must stay exactly as it is.
const moduleSrc = await read('api/booking/_authorization-window.js');
// It may READ from Stripe to learn the deadline; it must never write.
for (const forbidden of ['.capture(', '.cancel(', '.update(', "from('bookings')"]) {
  assert.ok(!moduleSrc.includes(forbidden),
    `the window module must not ${forbidden} — it decides, callers act`);
}

// ── 9. The owner's four words ───────────────────────────────────────────────
assert.equal(authorizationReadinessLabel(sevenDay, onBookingDay), 'Payment ready');
assert.equal(authorizationReadinessLabel(sevenDay, justInside), 'Authorization expiring');
assert.equal(authorizationReadinessLabel(incident(), onBookingDay), 'Payment action required');
assert.equal(authorizationReadinessLabel(incident({ payment_status: 'captured' })), 'Payment collected');

console.log('PASS authorization window: the Sep 19 incident is caught on the day it is booked, five days before anyone travels');
