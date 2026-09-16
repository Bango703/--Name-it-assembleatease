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
const html = buildAssignmentEmail({
  firstName: 'Travis', service: 'Outdoor & Playsets', date: '2026-09-24',
  time: '8:00 AM – 10:00 AM', estimatedPayCents: split.assemblerDueCents,
  acceptUrl: 'https://x/a', declineUrl: 'https://x/d', ref: 'AAE-DVSNHXE4OO',
  offerLocation: deriveOfferLocation('14 BURGESS BEND WAY, SPRING, TX 77389'),
});
assert.equal((html.match(/\$\{/g) || []).length, 0, 'no unrendered placeholder may reach a real inbox');
const text = strip(html);
assert.match(text, /Spring, TX 77389/, 'the city must be in the email');
assert.doesNotMatch(text, /BURGESS BEND/, 'the street must not be');
assert.match(text, new RegExp(`unlock ${CONTACT_RELEASE_LEAD_HOURS} hours before the appointment`),
  'contact timing must match the real release window');
assert.doesNotMatch(text, /Customer contact and exact address are shown after acceptance/,
  'the sentence that promised contact at acceptance must not come back');
assert.match(text, /\$275\.80/, 'earnings must be the canonical 70% of the pre-tax subtotal');

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
for (const rel of CUSTOMER_AND_EASER_EMAILS) {
  const src = await read(rel);
  const raw = [...src.matchAll(/\$\{esc\((?:booking\.)?date(?: \|\| [^)]*)?\)\}/g)];
  assert.deepEqual(raw.map(m => m[0]), [],
    `${rel} prints a raw appointment date into an email — use formatAppointmentDate`);
  assert.match(src, /formatAppointmentDate/, `${rel} must format its appointment dates`);
}

console.log('assignment email accuracy tests: PASS');
