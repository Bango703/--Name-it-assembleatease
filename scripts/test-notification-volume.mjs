#!/usr/bin/env node
// Emails nobody needed, counted on one real booking.
//
// AAE-DVSNHXE4OO, 15-19 Sep 2026. The customer received six emails in five
// days. Two of them carried the identical subject "Your Easer is confirmed"
// 44 minutes apart, naming two different people, because the first Easer took
// the job and dropped it; nothing in the second email said anything had
// changed. The Easer side was worse: assign, release, assign again sent the
// same person the same "You've got a new job" email four times in ten hours.
//
// The owner's instruction was blunt: stop sending email that does not need to
// be sent. These tests hold that line.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCustomerEaserEmail } from '../api/booking/accept-dispatch.js';

const booking = {
  id: 'b-1',
  ref: 'AAE-DVSNHXE4OO',
  customer_name: 'Lee Ann Nesloney',
  service: 'Outdoor & Playsets',
};
const common = {
  booking,
  appointmentDate: '2026-09-24',
  appointmentTime: '8:00 AM – 10:00 AM',
  appointmentDescription: 'your Outdoor & Playsets',
  manageUrl: 'https://www.assembleatease.com/track?ref=AAE-DVSNHXE4OO',
};

// ── 1. First time: the customer is told someone is coming ───────────────────
{
  const first = buildCustomerEaserEmail({ ...common, easerFirstName: 'Travis', easerChanged: false });
  assert.equal(first.subject, 'Your Easer is confirmed — AAE-DVSNHXE4OO');
  assert.match(first.html, /Your Easer is confirmed\./);
  assert.match(first.html, /good news/);
  assert.match(first.html, /Travis/);
}

// ── 2. Second time: it is a change, and says so ─────────────────────────────
{
  const second = buildCustomerEaserEmail({ ...common, easerFirstName: 'Phil', easerChanged: true });
  assert.equal(second.subject, 'Your Easer has changed — AAE-DVSNHXE4OO',
    'the second email must not repeat the first subject');
  assert.match(second.html, /Your Easer has changed\./);
  assert.match(second.html, /there is a change to your booking/);
  assert.match(second.html, /Phil/);
  assert.match(second.html, /Everything else stays the same/,
    'and must reassure, not alarm');
  assert.doesNotMatch(second.html, /good news/);
}

// ── 3. Both say the date the way a person reads it ──────────────────────────
for (const changed of [false, true]) {
  const email = buildCustomerEaserEmail({ ...common, easerFirstName: 'Phil', easerChanged: changed });
  assert.match(email.html, /Thursday, September 24, 2026/, 'the appointment date is written out');
  assert.doesNotMatch(email.html, /2026-09-24/, 'never the stored ISO date');
}

// ── 4. The sender asks the log whether we already told them ─────────────────
const acceptSource = await readFile(new URL('../api/booking/accept-dispatch.js', import.meta.url), 'utf8');
assert.match(acceptSource, /customerAlreadyToldOfEaser/, 'the change is decided from what was actually sent');
assert.match(acceptSource, /notification_log[\s\S]{0,260}job_accepted/,
  'by reading the notification log, not a second field that can drift');
assert.match(acceptSource, /easerChanged/, 'and passed into the one email builder');

// ── 5. The same Easer is not re-emailed for the same job within the hour ────
const assignSource = await readFile(new URL('../api/booking/assign.js', import.meta.url), 'utf8');
const assignmentMeta = assignSource.slice(
  assignSource.indexOf("notificationType: 'assignment_confirmation'") - 400,
  assignSource.indexOf("notificationType: 'assignment_confirmation'") + 200,
);
assert.doesNotMatch(assignmentMeta, /disableDedupe:\s*true/,
  'an identical assignment email inside the hour must not be forced through');
assert.match(assignmentMeta, /dedupeWindowMin:\s*60/, 'one hour, keyed on recipient and subject');
// Push is a different channel and still fires every time, so an Easer is never
// left unaware of a job they have been given (Rule 10).
assert.match(assignSource, /sendPushToUser\(assemblerId/, 'push still fires on every assignment');

console.log('Notification volume tests: PASS');
