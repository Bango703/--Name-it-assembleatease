#!/usr/bin/env node
// A confirmed Easer no-show protects the customer (owner P0, 2026-11-08):
// no cancellation fee, no reschedule counted against her, and she is told we
// are finding a new pro. Plus the reschedule dates come from the server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeCancellationFee } from '../api/_source-of-truth.js';
import { evaluateCancellationPolicy } from '../api/booking/_cancellation-policy-truth.js';
import { customerCancellationMessage, cancellationFeeSummary, CANCELLATION_REASONS } from '../api/booking/_cancellation-fee-summary.js';
import { easerMissedVisit, awaitingReplacementPro } from '../api/booking/_easer-no-show.js';
import { customerStatusLabel, customerProgress } from '../api/booking/_customer-status.js';
import { rescheduleDateBounds } from '../api/booking/reschedule.js';
import { bookingWindow, addIsoDays } from '../api/booking/_booking-window.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

// The fee rule.
{
  const base = { serviceSubtotalCents: 20000, hoursUntilAppointment: 0.5, status: 'confirmed', easerAccepted: true };
  assert.equal(computeCancellationFee(base).tier, 'imminent', 'without the no-show: imminent tier, as today');
  assert.deepEqual(computeCancellationFee({ ...base, easerNoShow: true }), { tier: 'free', feePct: 0, feeCents: 0, proTripCut: false, waivedReason: 'easer_no_show', reason: 'easer_no_show' });
  assert.equal(computeCancellationFee({ ...base, easerNoShow: true, forfeitFreeWindow: true }).feeCents, 0, 'a reschedule does not bring a fee back');
  assert.equal(computeCancellationFee({ ...base, easerNoShow: true, status: 'en_route' }).feeCents, 0, 'nor a replacement pro on the way');
  assert.equal(computeCancellationFee({ ...base, easerNoShow: true, isNoShow: true }).tier, 'imminent', 'the owner\'s explicit customer no-show still applies');
}
console.log('PASS fee rule: an owner-confirmed Easer no-show makes cancelling free; only an explicit customer no-show overrides');

// The one policy evaluator every cancel path and the tracking page call.
{
  const soon = new Date(Date.now() + 30 * 60000);
  const date = soon.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const booking = { id: 'b1', status: 'confirmed', date, time: '8:00 AM - 10:00 AM', total_price: 21650, tax_amount: 1650, service_call_fee: 0, reschedule_count: 2, assembler_id: 'e2', assembler_accepted_at: new Date().toISOString() };
  const missed = { ...booking, easer_no_show_confirmed_at: new Date(Date.now() - 3600000).toISOString() };
  const { policy } = evaluateCancellationPolicy(missed, { nowMs: Date.now() });
  assert.equal(policy.reason, 'easer_no_show');
  assert.equal(policy.feeCents, 0);
  assert.notEqual(evaluateCancellationPolicy(booking, { nowMs: Date.now() }).policy.feeCents, 0, 'the same booking without the no-show still has a fee');
  assert.ok(CANCELLATION_REASONS.includes('easer_no_show'));
  assert.equal(customerCancellationMessage(policy), 'Cancellation is free for this booking.');
  assert.equal(cancellationFeeSummary({ policy }).text, 'No fee charged: the assigned Easer did not show for this job.');
}
console.log('PASS policy: customer cancel, guest cancel and the tracking preview all see the waiver, in words for both');

// Who is still waiting for a new pro.
{
  const missedAt = '2026-11-06T16:00:00Z';
  assert.equal(easerMissedVisit({}), false);
  assert.equal(awaitingReplacementPro({ easer_no_show_confirmed_at: missedAt, assembler_accepted_at: '2026-11-05T12:00:00Z', assembler_id: 'santiago', assembler_name: 'Santiago R' }), true, 'still the Easer who missed it');
  assert.equal(awaitingReplacementPro({ easer_no_show_confirmed_at: missedAt, assembler_accepted_at: null }), true, 'reassigned, not accepted yet');
  assert.equal(awaitingReplacementPro({ easer_no_show_confirmed_at: missedAt, assembler_accepted_at: '2026-11-07T09:00:00Z' }), false, 'a new pro accepted afterwards');

  const waiting = { status: 'confirmed', date: '2026-11-06', time: '8:00 AM - 10:00 AM', assembler_id: 'santiago', assembler_name: 'Santiago R', assembler_accepted_at: '2026-11-05T12:00:00Z', easer_no_show_confirmed_at: missedAt, payment_status: 'authorized' };
  assert.deepEqual(customerStatusLabel(waiting), { label: 'We are finding you a new pro', detail: 'We will confirm your pro and new time with you. You will not be charged for the missed visit.' });
  assert.equal(customerProgress(waiting).step, 0, 'the tracker no longer shows "Pro confirmed"');
  const replaced = { ...waiting, assembler_name: 'Marcus T', assembler_accepted_at: '2026-11-07T09:00:00Z' };
  assert.match(customerStatusLabel(replaced).label, /^Marcus is confirmed/);
  assert.equal(customerProgress(replaced).step, 1);
  assert.equal(customerStatusLabel({ ...waiting, status: 'cancelled' }).label, 'Booking cancelled');
}
console.log('PASS customer status: "finding you a new pro" until a new pro accepts, in the page, the app list and pushes');

// The dates a booking can move to, from the server's own rules.
{
  const now = new Date('2026-11-08T18:00:00Z');
  const w = bookingWindow(now);
  const held = { payment_status: 'authorized', status: 'confirmed', payment_method_type: 'card', stripe_payment_intent_id: 'pi', stripe_customer_id: 'cus', stripe_payment_method_id: 'pm', total_price: 100 };
  assert.deepEqual(rescheduleDateBounds(held, now), { minDate: w.firstDate, maxDate: w.lastDate }, 'a held card that can wait moves anywhere in the window');
  assert.deepEqual(rescheduleDateBounds({ ...held, payment_method_type: 'klarna' }, now), { minDate: w.firstDate, maxDate: w.immediateAuthorizationLastDate }, 'Klarna stays inside the hold window');
  assert.deepEqual(rescheduleDateBounds({ payment_status: 'card_saved' }, now), { minDate: addIsoDays(w.immediateAuthorizationLastDate, 1), maxDate: w.lastDate }, 'a saved card moves past the hold window');
  assert.deepEqual(rescheduleDateBounds({ payment_status: 'pending' }, now), { minDate: w.firstDate, maxDate: w.lastDate });

  const page = read('track.html');
  assert.doesNotMatch(page, /savedCardWindow|\? 30 : 6|rsAddDays\(today, 7\)/, 'the page no longer keeps its own copy of the date rule');
  assert.match(page, /if \(options && options\.min_date && options\.max_date\) return \{ min: options\.min_date, max: options\.max_date \};/);
  assert.match(page, /if \(note && currentBooking\.reschedule_note\) note\.textContent = currentBooking\.reschedule_note;/);
  const track = read('api/booking/track.js');
  assert.match(track, /const bounds = rescheduleDateBounds\(booking\);\n\s*return \{ slots: TIME_SLOTS, window_days: BOOKING_WINDOW_DAYS, min_date: bounds\.minDate, max_date: bounds\.maxDate \};/);
  assert.match(track, /can_reschedule: RESCHEDULABLE_STATUSES\.includes\(booking\.status\) && \(rescheduleCount < MAX_RESCHEDULES \|\| easerMissedVisit\(booking\)\),/);
  assert.match(track, /'Rescheduling is free and cancellation stays free for this booking\.'/);
}
console.log('PASS dates: the server decides which days a booking can move to; the page shows them and the no-show note');

// Wiring: the move does not count, every reader selects the column, the owner flow.
{
  assert.match(read('api/booking/reschedule.js'), /const countsAsReschedule = !acceptedProposal && !easerMissedVisit\(booking\)( && !byOwner)?;/);
  assert.match(read('api/booking/customer-bookings.js'), /assembler_accepted_at, easer_no_show_confirmed_at, payment_status/);
  assert.match(read('api/_customer-push.js'), /assembler_accepted_at, easer_no_show_confirmed_at, payment_status/);
  for (const f of ['api/booking/track.js', 'api/booking/customer-cancel.js', 'api/booking/guest-cancel.js', 'api/booking/cancel.js', 'api/owner/confirm-no-show.js']) {
    assert.match(read(f), /\.select\('\*'\)/, `${f} reads the whole row, so it sees the column`);
  }
  const confirm = read('api/owner/confirm-no-show.js');
  const protect = confirm.indexOf('if (!(await protectCustomer(new Date(nowMs).toISOString())))');
  const strike = confirm.indexOf('const record = await recordEaserCancellation(');
  assert.ok(protect > 0 && strike > protect, 'the customer is protected before any strike is recorded');
  assert.match(confirm, /if \(!\(await protectCustomer\(existing\[0\]\.created_at\)\)\)/, 'a repeat tap protects an earlier no-show, dated from it');
  assert.match(confirm, /\.is\('easer_no_show_confirmed_at', null\)/, 'never moves an existing date');
  const owner = read('owner/index.html');
  const recorded = owner.indexOf("button.textContent = 'No-show recorded';");
  const after = recorded > 0 ? owner.slice(recorded, recorded + 700) : '';
  assert.ok(after.includes('// Reassign in the same step') && after.includes('window.toggleReassign();'), 'Reassign opens in the same step');
  const mig = read('api/migrations/126_easer_no_show_customer_protection.sql');
  assert.match(mig, /ADD COLUMN IF NOT EXISTS easer_no_show_confirmed_at TIMESTAMPTZ;/);
  assert.match(mig, /WHERE event_type = 'easer_cancelled' AND metadata->>'kind' = 'no_show'/, 'past confirmed no-shows are backfilled');
  assert.match(mig, /VALUES \(126, 'easer_no_show_customer_protection'\)/);
}
console.log('PASS wiring: moves after a no-show never count, every reader selects the column, protection before strikes, Reassign in one step');
console.log('\nEaser no-show customer protection tests passed.');
