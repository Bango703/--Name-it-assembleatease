#!/usr/bin/env node
// The owner moves a booking to a new time (owner, 2026-11-08). Same route and
// rules as the customer's reschedule; the owner's move never counts against
// the customer, and the owner is not emailed about their own change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const src = read('api/booking/reschedule.js');

// Server: owner access, same rules.
{
  assert.match(src, /const byOwner = verifyOwner\(req\);\n\s*if \(req\.method === 'GET' && byOwner\) return ownerMoveOptions\(req, res\);/, 'GET is owner only');
  assert.match(src, /if \(!ref \|\| !date \|\| !time \|\| \(!byOwner && !viaAccount && \(!email \|\| !token\)\)\)/, 'a customer still needs their link or account');
  assert.match(src, /if \(!booking \|\| \(!byOwner && !\(await customerBookingAccess\(sb, req, booking, \{ email, token \}\)\)\.ok\)\)/, 'only the owner skips the customer check');
  assert.match(src, /const countsAsReschedule = !acceptedProposal && !easerMissedVisit\(booking\) && !byOwner;/, 'the owner\'s move never uses the customer\'s reschedules');
  assert.match(src, /const ownerResult = byOwner \? \{ ok: true, skipped: 'owner_made_this_change' \} : await sendEmail\(/, 'no email to the owner about their own move');
  assert.match(src, /actorType: byOwner \? 'owner' : 'guest',/, 'the timeline says the owner did it');
  assert.match(src, /This booking's payment cannot be held again automatically for that date/, 'the owner gets owner words for a payment refusal');
  const options = src.slice(src.indexOf('async function ownerMoveOptions'), src.indexOf('export default async function handler'));
  assert.match(options, /const bounds = rescheduleDateBounds\(booking\);/, 'the owner picker uses the same date rule');
  assert.match(options, /slots: TIME_SLOTS,/, 'and the same arrival windows');
  // Every rule after access still runs for the owner: status, payment, window, offers, Easer reconfirmation.
  for (const rule of ['RESCHEDULABLE_STATUSES.includes(booking.status)', 'reschedulePaymentConflict(booking, date)', 'validateBookingWindowDate(date)', "update({ offer_status: 'cancelled' })", 'const reconfirmationRequired = Boolean(booking.assembler_id) && !acceptedProposal;']) {
    assert.ok(src.includes(rule), `still enforced: ${rule}`);
  }
  assert.match(src, /\$\{acceptedProposal \? 'This is the time your pro proposed\. ' : ''\}Your cancellation terms are unchanged\./, 'the customer email says only what is true for this move');
}
console.log('PASS server: the owner moves a booking through the same route and rules; it never counts against the customer');

// Owner screen.
{
  const page = read('owner/index.html');
  assert.match(page, /if \(\['pending','confirmed'\]\.includes\(b\.status\) && !b\.return_visit_required\) \{\n\s*btns\.push\('<button class="btn" data-action="move-appointment"/, 'the button shows where the server allows a move');
  assert.match(page, /fetch\('\/api\/booking\/reschedule\?ref=' \+ encodeURIComponent\(moveBooking\.ref\), \{ headers: headers\(\) \}\)/, 'times and dates come from the server');
  assert.match(page, /body: JSON\.stringify\(\{ ref: pendingAction\.ref, date: newDate, time: newTime \}\),/);
  assert.match(page, /if \(!moveResponse\.ok\) throw new Error\(moveData\.error \|\| 'The appointment could not be moved\.'\);/, 'a refusal shows the server\'s reason');
  assert.match(page, /setReturnVisitFieldsVisible\(false\);\n\s*setMoveAppointmentFieldsVisible\(false\);/, 'the form resets with the others');
  assert.match(page, /<label class="modal-label" for="move-appointment-date">New date<\/label>/);
}
console.log('PASS owner screen: "Move to a New Time" picks from the server\'s times and dates and shows its reason on a refusal');
console.log('\nOwner move appointment tests passed.');
