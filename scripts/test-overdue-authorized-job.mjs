#!/usr/bin/env node
// A job whose time has passed, still holding the customer's money, is not silent.
//
// THE MIRROR OF THE SEPTEMBER INCIDENT. There, capture ran at completion and
// failed because the hold had died. Here capture never runs at all: the Easer
// forgets to close the job, or never turns up, the appointment slides into the
// past, and the authorization expires with the work unpaid and nobody told.
// Same silence, opposite direction.
//
// WHAT THIS ALERT MUST NOT DO. Capture. From the outside we cannot tell a
// forgotten completion from a no-show, and charging for work that did not
// happen is worse than collecting late. The alert exists so the owner can find
// out while there is still a hold to collect.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('// ── Overdue authorized job'), src.indexOf("quoteNeedsPricing.forEach"));
assert.ok(block.length > 500, 'the overdue-authorized-job alert must exist');

// ── The two named conditions ────────────────────────────────────────────────
// PAST_APPOINTMENT_NOT_COMPLETE and AUTHORIZED_PAYMENT_STILL_OPEN occur apart:
// a job paid offline can be left open with no money at risk, and every healthy
// booking sits in the second state between authorization and completion. The
// urgent alert is their conjunction; the job one alone still gets surfaced.
assert.match(block, /pastAppointmentNotComplete\(b, now_ts\)/,
  'the job condition must be the shared predicate, not restated inline');
assert.match(block, /authorizedPaymentStillOpen\(b\)/,
  'and so must the money condition');

const { pastAppointmentNotComplete, authorizedPaymentStillOpen } =
  await import('../api/booking/_authorization-window.js');
const past = { status: 'confirmed', date: '2026-09-24', time: '8:00 AM - 10:00 AM' };
const NOW = Date.parse('2026-09-26T00:00:00Z');
assert.equal(pastAppointmentNotComplete(past, NOW), true, 'a job whose time has gone is open');
assert.equal(pastAppointmentNotComplete({ ...past, completed_at: '2026-09-24T12:00:00Z' }, NOW), false,
  'a completed job is not');
assert.equal(pastAppointmentNotComplete({ ...past, status: 'cancelled' }, NOW), false,
  'nor is a cancelled one');
assert.equal(pastAppointmentNotComplete(past, Date.parse('2026-09-24T00:00:00Z')), false,
  'and not before the appointment has passed');

assert.equal(authorizedPaymentStillOpen({ payment_status: 'authorized' }), true);
assert.equal(authorizedPaymentStillOpen({ payment_status: 'captured' }), false, 'collected money is not open');
assert.equal(authorizedPaymentStillOpen({ payment_status: 'authorized', payment_collected: true }), false);
assert.equal(authorizedPaymentStillOpen({ payment_status: 'offline_recorded' }), false,
  'an offline booking has no hold to lose');

// The job-only alert must exist, and must not claim money is at risk.
const jobOnly = src.slice(src.indexOf("// PAST_APPOINTMENT_NOT_COMPLETE on its own"), src.indexOf("quoteNeedsPricing.forEach"));
assert.ok(jobOnly.includes("type: 'past_appointment_not_complete'"), 'the job-only alert must exist');
assert.match(jobOnly, /!authorizedPaymentStillOpen\(b\)/,
  'it must be the complement, so one booking never raises both');
assert.match(jobOnly, /nothing is at risk of expiring/,
  'and must say plainly that no hold is about to be lost');
assert.doesNotMatch(jobOnly, /severity: 'critical'/,
  'without money at stake it must not outrank an expiring hold');

// ── It must never take the money ────────────────────────────────────────────
for (const forbidden of ['capture(', 'paymentIntents', 'payment_collected: true', 'captureOrRecover']) {
  assert.ok(!block.includes(forbidden),
    `the alert must not ${forbidden} — it reports, the owner decides`);
}

// ── Everything the owner needs to investigate, in the alert itself ──────────
// Without these the owner has an alert and still has to go digging, which in
// practice means it waits until tomorrow, by which time the hold is gone.
for (const field of ['overdueHours', 'captureBefore', 'hoursUntilHoldExpires',
                     'jobState', 'easerName', 'easerId', 'customerName',
                     'startedAt', 'arrivedAt', 'enRouteAt']) {
  assert.ok(block.includes(`${field}:`) || block.includes(`${field},`),
    `the alert must carry ${field}`);
}

// The timeline stamps are what separate the six cases the owner has to tell
// apart: forgot to close, no-show, still working, abandoned, rescheduled,
// technical failure. en_route with no arrival reads very differently from
// started-but-never-finished.
assert.match(block, /job_started_at/, 'started-but-never-closed must be visible');
assert.match(block, /checked_in_at/, 'arrived-but-never-started must be visible');
assert.match(block, /en_route_at/, 'never-arrived must be visible');

// ── Urgency tracks the money, not the delay ─────────────────────────────────
// A job 2 hours overdue with 3 hours of hold left is worse than one 3 days
// overdue with a week left.
assert.match(block, /hoursLeft == null \|\| hoursLeft <= 24 \? 'critical' : 'high'/,
  'a hold about to expire must outrank the general pile');
assert.match(block, /the payment hold expiry was never recorded/,
  'an unrecorded deadline is called out, not treated as plenty of time');
assert.match(block, /the payment hold has already expired/,
  'and an expired hold says so plainly');

// ── The projection has to carry the deadline ────────────────────────────────
// Omitting it from the SELECT is the bug this codebase keeps relearning: the
// field reads undefined, the alert renders "expiry never recorded" on every
// booking, and the signal becomes noise.
const projection = src.match(/const bookingProjection = '([^']+)'/);
assert.ok(projection, 'the booking projection must exist');
for (const column of ['authorization_capture_before', 'completed_at', 'payment_collected',
                      'job_started_at', 'checked_in_at', 'en_route_at', 'assembler_name']) {
  assert.ok(projection[1].includes(column),
    `the projection must select ${column} or the alert silently reads undefined`);
}

// ── The wording is for an operator, and it does not pre-judge ───────────────
assert.match(block, /do not charge for a job that did not/,
  'the message must say plainly that charging is not the default');
// Scoped to the sentence the owner reads. The block itself necessarily names
// the column it reads; the message must not.
const message = block.slice(block.indexOf('message:'), block.indexOf("action:"));
assert.doesNotMatch(message, /PaymentIntent|capture_before|payment_status/,
  'the owner console may use real terms, but not raw Stripe or column names');

console.log('PASS overdue authorized job: fires on a passed appointment with money still held, carries the evidence, captures nothing');
