#!/usr/bin/env node
// Every SMS the platform sends must fit one segment at worst case.
//
// A simulation on 2026-09-08 sent one of each message to a real handset and the
// booking confirmation came back as 2 parts at 171 characters — double cost on
// the most-sent customer message, and it can arrive split. _sms.js already
// documented "keep it under 160 chars"; nothing enforced it.
//
// Two things decide the limit, and both are checked here:
//
//   LENGTH. The cap is 160 for a single GSM-7 segment, and the budget must
//   include the " Reply STOP to opt out." that _sms.js:81 appends to every
//   message. Templates are measured with the LONGEST realistic substitutions,
//   not a convenient sample — the first attempt at this fix passed with
//   "Furniture Assembly" and still ran to 161 with "Mounting & Hanging".
//
//   ENCODING. One character outside GSM-7 switches the whole message to UCS-2
//   and drops the single-segment limit from 160 to 70. A curly apostrophe would
//   do it silently, and smart_encoding is OFF on the Telnyx profile, so nothing
//   downstream would rescue it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toGsm7 } from '../api/_sms.js';
import { formatAppointmentDateShort, formatSlotShort } from '../api/booking/_appt-date.js';
import { buildDayOfReminderSms } from '../api/cron/reminders.js';
import { buildArrivalNudgeSms } from '../api/cron/easer-arrival-nudge.js';

const OPT_OUT = ' Reply STOP to opt out.';
const GSM7_LIMIT = 160;

// Worst realistic values. Service names come from the booking catalog, refs from
// the longest form seen in production.
//
// The date and time are NOT hand-typed samples any more. This test used to
// measure date '2026-09-09' and time '2:00 PM', while production sends the stored
// slot "10:00 AM \u2013 12:00 PM": twelve characters longer and carrying an en dash
// that forces UCS-2. The test passed while four real texts went out in three
// parts each. So the slot is read from the booking form's own list, and every
// body goes through the same formatters and toGsm7() that the senders use.
const bookSource = readFileSync(new URL('../book.html', import.meta.url), 'utf8');
const slotList = bookSource.match(/var TIME_SLOTS = (\[[^\]]+\])/);
assert.ok(slotList, 'book.html TIME_SLOTS not found');
const TIME_SLOTS = JSON.parse(slotList[1].replace(/'/g, '"'));
const longestSlot = TIME_SLOTS.reduce((a, b) => (formatSlotShort(b).length > formatSlotShort(a).length ? b : a));
assert.ok(TIME_SLOTS.some(s => /[\u2013\u2014]/.test(s)),
  'the stored slots carry a dash -- if that changed, revisit why toGsm7 exists');

const service = 'Mounting & Hanging';
const date = formatAppointmentDateShort('2026-09-30');   // two-digit day: the longest short date
const time = formatSlotShort(longestSlot);
const ref = 'AAE-LYTX3WIQW3';
const pay = '$1,250.00 est. ';
const easerFirstName = 'Bartholomew';
const helperDue = 125000;

const MESSAGES = {
  dispatch_offer:
    `New AssembleAtEase job: ${service} ${date} at ${time}. ${pay}Open the app to accept. Ref ${ref}`,
  assignment_confirmation:
    `New AssembleAtEase job: ${service} on ${date}, ${time}. Open your dashboard to accept. Ref ${ref}`,
  crew_added:
    `You've been added to an AssembleAtEase job: ${service} ${date}. $${(helperDue / 100).toFixed(2)} est. Open the app for details. Ref ${ref}`,
  arrival_nudge:
    buildArrivalNudgeSms(ref),
  customer_day_of_reminder:
    buildDayOfReminderSms({ ref, time: longestSlot }, 'customer'),
  easer_day_of_reminder:
    buildDayOfReminderSms({ ref, time: longestSlot }, 'easer'),
  booking_confirmed:
    `AssembleAtEase: ${service} booked for ${date} ${time}. We'll text when your Easer is on the way. Ref ${ref}`,
  en_route:
    `${easerFirstName} is on the way to your AssembleAtEase appointment. Arrival window: ${time}. Ref ${ref}`,
  arrived:
    `${easerFirstName} has arrived for your AssembleAtEase appointment. Ref ${ref}`,
};

// The GSM 03.38 basic set plus its extension characters.
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
  + '^{}\\[~]|€';

let failures = 0;
for (const [name, body] of Object.entries(MESSAGES)) {
  const full = toGsm7(body) + OPT_OUT;

  const nonGsm = [...full].filter(ch => !GSM7.includes(ch));
  if (nonGsm.length) {
    console.error(`FAIL ${name}: non-GSM-7 character(s) ${JSON.stringify(nonGsm)} `
      + '- this drops the single-segment limit from 160 to 70');
    failures += 1;
    continue;
  }

  if (full.length > GSM7_LIMIT) {
    console.error(`FAIL ${name}: ${full.length} chars at worst case, limit ${GSM7_LIMIT}`);
    console.error(`     ${full}`);
    failures += 1;
    continue;
  }
  console.log(`  ${name.padEnd(24)} ${String(full.length).padStart(3)} chars  (${GSM7_LIMIT - full.length} to spare)`);
}

assert.equal(failures, 0, `${failures} SMS template(s) would send as more than one segment`);

// The templates above are copies. If the real one drifts, this proves nothing —
// so check the shipped source still matches the shape we measured.
const src = readFileSync(new URL('../api/booking-confirmed.js', import.meta.url), 'utf8');
assert.match(src, /AssembleAtEase: \$\{service\} booked for/,
  'booking-confirmed.js no longer matches the template measured here');
assert.doesNotMatch(src, /AssembleAtEase received your \$\{service\} booking for/,
  'The 172-character wording is back');

// Every shipped template that prints a date or time must use the short
// formatters measured above, and the sender must convert to GSM-7 before it
// counts -- otherwise the measurement above describes a message nobody sends.
const shipped = {
  'api/booking/_dispatch-internal.js': [/formatAppointmentDateShort\(booking\.date\)/, /formatSlotShort\(booking\.time\)/],
  'api/booking/assign.js': [/on \$\{formatAppointmentDateShort\(booking\.date\)\}/, /formatSlotShort\(booking\.time\)/],
  'api/booking-confirmed.js': [/booked for \$\{formatAppointmentDateShort\(date\)\}/, /formatSlotShort\(time\)/],
  'api/booking/easer-status.js': [/Arrival window: \$\{formatSlotShort\(appointmentTime\)\}/],
  'api/owner/crew.js': [/formatAppointmentDateShort\(booking\.date\)/],
};
for (const [rel, patterns] of Object.entries(shipped)) {
  const body = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  for (const pattern of patterns) assert.match(body, pattern, `${rel} no longer matches the template measured here`);
}

// "Should arrive around 8 AM-10 AM" read as an arrival promise nobody computed.
// The on-the-way text and email state the booked window as a fact instead.
const statusSource = readFileSync(new URL('../api/booking/easer-status.js', import.meta.url), 'utf8');
assert.doesNotMatch(statusSource, /should arrive around/,
  'easer-status.js promises an arrival time again; state the booked window instead');
assert.match(statusSource, /Your arrival window is \$\{esc\(appointmentTime\)\}/,
  'the on-the-way email states the booked window');

const smsSource = readFileSync(new URL('../api/_sms.js', import.meta.url), 'utf8');
assert.match(smsSource, /const text = toGsm7\(String\(body \|\| ''\)\)\.trim\(\);/,
  '_sms.js must convert to GSM-7 before sending');

// The conversion itself, on the value production actually stores.
assert.equal(toGsm7('8:00 AM \u2013 10:00 AM'), '8:00 AM - 10:00 AM');
assert.equal(toGsm7('it\u2019s \u201Cready\u201D\u2026'), 'it\'s "ready"...');
assert.equal(toGsm7('plain text stays plain'), 'plain text stays plain');

console.log(`\nPASS all ${Object.keys(MESSAGES).length} SMS templates fit one GSM-7 segment at worst case`);
