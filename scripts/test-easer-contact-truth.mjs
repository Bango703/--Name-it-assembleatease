import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { redactAssignmentCustomerData } from '../api/booking/my-assignments.js';
import { appointmentTimestampMs, formatAppointmentDateShort, formatSlotShort } from '../api/booking/_appt-date.js';

// What an Easer can see about a customer, and what every message says they can
// see, must be the same thing. The owner asked for this to be checked flow by
// flow: "don't put something that doesn't exist."

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const DATE = '2026-09-24';
const TIME = '8:00 AM – 10:00 AM';
const APPT = appointmentTimestampMs(DATE, TIME);
const HOUR = 3600 * 1000;

const booking = extra => ({
  status: 'confirmed',
  assembler_accepted_at: '2026-09-16T12:00:00Z',
  date: DATE,
  time: TIME,
  customer_name: 'Lee Ann Nesloney',
  customer_phone: '281-555-0100',
  customer_email: 'lee@example.com',
  address: '14 Burgess Bend Way, Spring, TX 77389',
  ...extra,
});

// ── 1. The customer's email never reaches an Easer, at any point ───────────
for (const [label, row, now] of [
  ['before accepting', booking({ assembler_accepted_at: null }), APPT - 200 * HOUR],
  ['accepted, days out', booking(), APPT - 200 * HOUR],
  ['inside the 24h window', booking(), APPT - 2 * HOUR],
  ['on the way', booking({ status: 'en_route' }), APPT - HOUR],
  ['completed', booking({ status: 'completed' }), APPT + 10 * HOUR],
]) {
  const [out] = redactAssignmentCustomerData([row], now);
  assert.equal(out.customer_email, null, `${label}: the customer email must never be sent to an Easer`);
}

const assignmentsApi = await read('api/booking/my-assignments.js');
const selectLine = assignmentsApi.match(/\.select\('id, ref, source, service,[^']*'\)/);
assert.ok(selectLine, 'the assignments query must exist');
assert.doesNotMatch(selectLine[0], /customer_email/,
  'the assignments query must not even read the customer email');

// ── 2. Every Easer screen agrees ────────────────────────────────────────────
const jobs = await read('assembler/my-assignments.html');
const home = await read('assembler/index.html');
assert.doesNotMatch(jobs, /customer_email/, 'the Jobs screen must not render a customer email');
assert.doesNotMatch(home, /customer_email/, 'the Home screen must not render or fall back to a customer email');
assert.doesNotMatch(jobs, /phone and email unlock/i, 'the locked contact card must not promise an email');
assert.match(jobs, /The customer\\'s phone number unlocks/);

// ── 3. The promises in the assignment email hold ────────────────────────────
// "Full address shows when you accept."
const [accepted] = redactAssignmentCustomerData([booking()], APPT - 200 * HOUR);
assert.equal(accepted.address, '14 Burgess Bend Way, Spring, TX 77389', 'accepting must reveal the full address');
// "The customer's phone number unlocks 24 hours before the job"
assert.equal(accepted.customer_phone, null, 'the phone is still held days out');
const [inside] = redactAssignmentCustomerData([booking()], APPT - 23 * HOUR);
assert.equal(inside.customer_phone, '281-555-0100', 'the phone unlocks inside the window');
// "until then, message them in the app" -- the relay is offered exactly while held
assert.match(jobs, /asgn-contact-relay/);
assert.match(jobs, /target: 'customer'/);

// ── 4. The Directions link on Home actually opens a map ─────────────────────
// maps.google.com/q= (no '?') returns HTTP 404.
assert.doesNotMatch(home, /'https:\/\/maps\.google\.com\/q='/, 'the Home Directions link must not use the 404 format');
assert.match(home, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&query='\+encodeURIComponent\(lj\.address\)/);

// ── 5. A helper is only promised an address that is there ───────────────────
// A helper can be added before the lead accepts, and the address is withheld
// until the lead does. The email must not claim otherwise.
const crew = await read('api/owner/crew.js');
assert.match(crew, /assembler_accepted_at, total_price,/, 'the crew email needs the lead acceptance to word its promise');
assert.match(crew, /booking\.assembler_accepted_at\s*\? 'Open your dashboard for the address and job details\.'/);
assert.match(crew, /The address appears in your dashboard once \$\{esc\(booking\.assembler_name \|\| 'the lead Easer'\)\} accepts the job\./);

// ── 6. Short forms used in texts ────────────────────────────────────────────
assert.equal(formatAppointmentDateShort('2026-09-24'), 'Thu, Sep 24');
assert.equal(formatAppointmentDateShort(''), '');
assert.equal(formatSlotShort('8:00 AM – 10:00 AM'), '8 AM-10 AM');
assert.equal(formatSlotShort('10:00 AM – 12:00 PM'), '10 AM-12 PM');
assert.equal(formatSlotShort('10:30 AM'), '10:30 AM', 'minutes that are not :00 are kept');
assert.equal(formatSlotShort(''), '');

console.log('Easer contact truth tests: PASS');
