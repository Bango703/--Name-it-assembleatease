import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAssignmentEmail } from '../api/booking/assign.js';
import { deriveOfferLocation } from '../api/booking/my-assignments.js';
import { CONTACT_RELEASE_LEAD_HOURS } from '../api/booking/_customer-contact-release.js';
import { CANCELLATION_POLICY, computeBookingSplitFromSnapshot, getPlatformFeePct } from '../api/_source-of-truth.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ── The pro must be able to judge the drive before accepting ───────────────
// deriveOfferLocation used to check the city against a 15-entry Austin
// allowlist, so a Spring (Houston) job and a Lubbock job both announced
// themselves as "Austin-area service zone" — actively misleading, not merely
// unhelpful, once bookings went statewide.
for (const [address, expected] of [
  ['14 BURGESS BEND WAY, SPRING, TX 77389', 'Spring, TX 77389'],
  ['9 Elm St, DEL VALLE, TX 78617', 'Del Valle, TX 78617'],
  ['5 Oak Dr, lubbock, TX 79401', 'Lubbock, TX 79401'],
  ['2 Pine, Round Rock, TX 78664', 'Round Rock, TX 78664'],
]) {
  assert.equal(deriveOfferLocation(address), expected, `${address} must name its real city`);
}
// Never claim a metro the job is not in.
for (const address of ['1 Ocean Ave, Santa Monica, CA 90401', '', 'nonsense', '5 Oak Dr, Nowhere, TX 00000']) {
  const out = deriveOfferLocation(address);
  assert.equal(out, 'Texas service area', `${JSON.stringify(address)} must fall back honestly, got ${out}`);
  assert.doesNotMatch(out, /Austin/, 'an unparseable address must never be labelled Austin');
}
// The city slot is free text. An unrecognised value is dropped, but the ZIP
// stays because it is what answers the distance question.
const freeText = deriveOfferLocation('123 Main Street, Private Person, TX 78701');
assert.equal(freeText, 'TX 78701');
assert.doesNotMatch(freeText, /Private|Person/i, 'a name in the address must never reach a pro pre-acceptance');
// The street is still withheld until acceptance.
assert.doesNotMatch(deriveOfferLocation('14 BURGESS BEND WAY, SPRING, TX 77389'), /BURGESS|WAY|14/);

// ── The email renders, and says only true things ───────────────────────────
const feePct = getPlatformFeePct(false);
const subtotal = 39400;
const tax = 3251;
const split = computeBookingSplitFromSnapshot({ totalPriceCents: subtotal + tax, taxCents: tax, feePct });
// nowMs is pinned. Without it this fixture drifted into "the job is today" as
// real time passed the appointment date, and the email's wording depends on
// how far away the job is.
const FAR_FUTURE_NOW = new Date('2026-09-01T09:00:00-05:00').getTime();
const html = buildAssignmentEmail({
  firstName: 'Travis', service: 'Outdoor & Playsets', date: '2026-09-24',
  time: '8:00 AM – 10:00 AM', estimatedPayCents: split.assemblerDueCents,
  acceptUrl: 'https://x/a', declineUrl: 'https://x/d', ref: 'AAE-DVSNHXE4OO',
  offerLocation: deriveOfferLocation('14 BURGESS BEND WAY, SPRING, TX 77389'),
  nowMs: FAR_FUTURE_NOW,
});
assert.equal((html.match(/\$\{/g) || []).length, 0, 'no unrendered placeholder may reach a real inbox');
const text = strip(html);
assert.match(text, /Spring, TX 77389/, 'the city must be in the email');
assert.doesNotMatch(text, /BURGESS BEND/, 'the street must not be');
assert.doesNotMatch(text, /phone and email|email unlock/i,
  'the email must not promise the customer email -- an Easer never receives it');
assert.match(text, new RegExp(`phone number unlocks ${CONTACT_RELEASE_LEAD_HOURS} hours before the job`),
  'contact timing must match the real release window');
assert.doesNotMatch(text, /Customer contact and exact address are shown after acceptance/,
  'the sentence that promised contact at acceptance must not come back');
assert.match(text, /\$275\.80/, 'earnings must be the canonical 70% of the pre-tax subtotal');

// ── The email must not state tomorrow's rules on today's job ───────────────
// An Easer was assigned a job starting in three hours and told to "respond
// within 24 hours" and that the phone "unlocks 24 hours before" — a mark that
// had already passed. Both read as false to the person holding the job.
{
  const soonNow = new Date('2026-09-24T05:00:00-05:00').getTime(); // 3h before
  const soon = strip(buildAssignmentEmail({
    firstName: 'Travis', service: 'Outdoor & Playsets', date: '2026-09-24',
    time: '8:00 AM – 10:00 AM', estimatedPayCents: split.assemblerDueCents,
    acceptUrl: 'https://x/a', declineUrl: 'https://x/d', ref: 'AAE-DVSNHXE4OO',
    offerLocation: deriveOfferLocation('14 BURGESS BEND WAY, SPRING, TX 77389'),
    nowMs: soonNow,
  }));
  assert.match(soon, /Today at 8:00 AM/, 'a job today says today, not its calendar date');
  assert.match(soon, /phone number are yours the moment you accept/,
    'inside the release window the number is already available — do not promise it later');
  assert.doesNotMatch(soon, new RegExp(`unlocks ${CONTACT_RELEASE_LEAD_HOURS} hours before`),
    'that mark has already passed for a same-day job');
  assert.doesNotMatch(soon, /respond within 24 hours/,
    'the job happens before the 24 hours do');
  assert.match(soon, /accept or decline now/, 'say what the Easer should actually do');
}

// Far out, the standing rules are the true ones and must stay.
assert.match(text, /respond within 24 hours/, 'a distant job keeps the 24-hour response rule');
assert.doesNotMatch(text, /may be reassigned/,
  'stale-booking releases the assignment back to the office; it does not hand it to someone else');

// ── Customer emails must not assert a cancellation cause that may be false ─
// computeCancellationFee returns $0 unless an Easer ACCEPTED, so "because a pro
// has already reserved the time" states a cause the platform has not verified.
for (const rel of ['api/booking.js', 'api/booking-confirmed.js', 'api/assembler/stripe-webhook.js']) {
  const src = await read(rel);
  assert.doesNotMatch(src, /because a pro has already reserved the time|since a pro has reserved the time/,
    `${rel} must not assert a pro reserved the time — no fee applies until one accepts`);
  assert.match(src, /CANCELLATION_POLICY\.freeWindowHours/,
    `${rel} must quote the cancellation window, not restate the number`);
  assert.doesNotMatch(src, /Cancel at least 24 hours/,
    `${rel} must not pin the window — it drifts the moment the policy changes`);
}

// ── No email a customer or a pro reads may print a database date ──────────
// "Date 2026-09-24" is a column value, in a message whose job is to reassure
// someone that a stranger is coming to their home.
assert.match(text, /Thursday, September 24, 2026/, 'the date must read like a date');
assert.doesNotMatch(text, /2026-09-24/, 'no ISO date may survive into a sent email');

const CUSTOMER_AND_EASER_EMAILS = [
  'api/booking/assign.js', 'api/booking/_dispatch-internal.js', 'api/booking/confirm.js',
  'api/booking/cancel.js', 'api/booking/customer-cancel.js', 'api/booking/guest-cancel.js',
  'api/booking/reschedule.js', 'api/booking/rebook-payment.js', 'api/booking-confirmed.js',
  'api/cron/reminders.js', 'api/assembler/stripe-webhook.js',
  'api/cron/authorize-scheduled-payments.js', 'api/owner/crew.js',
];
// The list above was a list, and a list is how dates were missed: a template
// that printed `sDate`, `b.date` or `updates.date` sat outside it and kept
// showing 2026-09-24 in real inboxes, including an email subject line. So scan
// every API module for an appointment date printed without the formatter.
const { readdirSync, statSync } = await import('node:fs');
const { join, relative, sep } = await import('node:path');
const { fileURLToPath } = await import('node:url');
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'migrations') out.push(...walk(full)); }
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}
// A multi-booking owner list keeps a sortable ISO column on purpose.
const ISO_ALLOWED = new Set(['api/cron/reminders.js']);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const rawDate = /esc\((?:b|booking|row|job)\.date\b|esc\(date\)|esc\(updates\.date/;
// The field is not always reached through a booking: accept-dispatch.js picked
// the date into `appointmentDate` (return visits use a different column) and
// printed that, so the customer's "Your Easer is confirmed" email said
// "on 2026-09-24" while every other email said "Thursday, September 24, 2026".
// Any variable whose name ends in "date" counts, unless it was assigned from
// formatAppointmentDate.
const rawDateVariable = /esc\(([A-Za-z_$][\w$]*[Dd]ate)\)/;
const offenders = [];
for (const file of walk(join(repoRoot, 'api'))) {
  const rel = relative(repoRoot, file).split(sep).join('/');
  if (ISO_ALLOWED.has(rel)) continue;
  const text = await readFile(file, 'utf8');
  const formatted = new Set(
    [...text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*formatAppointmentDate/g)].map(m => m[1]),
  );
  text.split('\n').forEach((line, i) => {
    if (line.includes('formatAppointmentDate')) return;
    if (rawDate.test(line)) { offenders.push(`${rel}:${i + 1}`); return; }
    const variable = line.match(rawDateVariable);
    if (variable && !formatted.has(variable[1])) offenders.push(`${rel}:${i + 1} (${variable[1]})`);
  });
}
assert.deepEqual(offenders, [], 'appointment dates printed without formatAppointmentDate');

for (const rel of CUSTOMER_AND_EASER_EMAILS) {
  const src = await read(rel);
  const raw = [...src.matchAll(/\$\{esc\((?:booking\.)?date(?: \|\| [^)]*)?\)\}/g)];
  assert.deepEqual(raw.map(m => m[0]), [],
    `${rel} prints a raw appointment date into an email — use formatAppointmentDate`);
  assert.match(src, /formatAppointmentDate/, `${rel} must format its appointment dates`);
}

// ── Readable on a phone ─────────────────────────────────────────────────────
// On a 375px screen the label column leaves about 140px for each value. The
// Location cell used to hold a 30-word sentence, which stacked into ten lines,
// and table cells center vertically, so labels drifted to the middle of tall
// values. The row now holds only the city; the timing sits full-width below.
const locationCell = html.match(/>Location<\/td><td[^>]*>([\s\S]*?)<\/td>/);
assert.ok(locationCell, 'the Location row must exist');
assert.equal(strip(locationCell[1]), 'Spring, TX 77389',
  'the Location cell must hold only the city — anything longer stacks into a column on a phone');
const detailCells = html.match(/<td style="padding:6px 0;[^"]*"/g) || [];
assert.equal(detailCells.length, 10, 'the details table has ten cells');
for (const cell of detailCells) {
  assert.match(cell, /vertical-align:top/, 'every details cell must be top-aligned so labels do not float');
}
const locationEnd = html.indexOf('>Location</td>');
const acceptAt = html.indexOf('Accept Job');
const noteAt = html.indexOf('Full address shows when you accept.');
assert.ok(noteAt > locationEnd && noteAt < acceptAt,
  'the timing note must sit below the details box and above the buttons, at full width');

console.log('assignment email accuracy tests: PASS');
