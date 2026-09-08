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

const OPT_OUT = ' Reply STOP to opt out.';
const GSM7_LIMIT = 160;

// Worst realistic values. Service names come from the booking catalog, refs from
// the longest form seen in production.
const service = 'Mounting & Hanging';
const date = '2026-09-09';
const time = '2:00 PM';
const ref = 'AAE-LYTX3WIQW3';
const pay = '$1,250.00 est. ';
const easerFirstName = 'Bartholomew';
const helperDue = 125000;

const MESSAGES = {
  dispatch_offer:
    `New AssembleAtEase job: ${service} ${date} at ${time}. ${pay}Open the app to accept. Ref ${ref}`,
  assignment_confirmation:
    `New AssembleAtEase job: ${service} on ${date} ${time}. Open your dashboard to accept. Ref ${ref}`,
  crew_added:
    `You've been added to an AssembleAtEase job: ${service} ${date}. $${(helperDue / 100).toFixed(2)} est. Open the app for details. Ref ${ref}`,
  arrival_nudge:
    `AssembleAtEase: tap Arrived on ${ref} so the office knows you're on site.`,
  booking_confirmed:
    `AssembleAtEase: ${service} booked for ${date} ${time}. We'll text when your Easer is on the way. Ref ${ref}`,
  en_route:
    `${easerFirstName} is on the way to your AssembleAtEase appointment and should arrive around ${time}. Ref ${ref}`,
  arrived:
    `${easerFirstName} has arrived for your AssembleAtEase appointment. Ref ${ref}`,
};

// The GSM 03.38 basic set plus its extension characters.
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
  + '^{}\\[~]|€';

let failures = 0;
for (const [name, body] of Object.entries(MESSAGES)) {
  const full = body + OPT_OUT;

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

console.log('\nPASS all 7 SMS templates fit one GSM-7 segment at worst case');
