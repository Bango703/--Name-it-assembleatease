import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONTACT_RELEASE_LEAD_HOURS,
  CONTACT_RELEASE_CODE,
  evaluateCustomerContactRelease,
} from '../api/booking/_customer-contact-release.js';
import { appointmentTimestampMs } from '../api/booking/_appt-date.js';
import { redactAssignmentCustomerData } from '../api/booking/my-assignments.js';
import { CANCELLATION_POLICY } from '../api/_source-of-truth.js';
import { computeLeakageSignals } from '../api/booking/_leakage-signal.js';

const DATE = '2026-10-14';
const TIME = '10:00 AM - 12:00 PM';
const APPT = appointmentTimestampMs(DATE, TIME);
assert.ok(Number.isFinite(APPT), 'test fixture appointment must parse');
const HOUR = 3600 * 1000;

// ── The number is not arbitrary; it is the free-cancellation boundary ───────
// If someone retunes the cancellation policy, the contact window must move
// with it or the leakage rationale silently stops holding.
assert.equal(
  CONTACT_RELEASE_LEAD_HOURS,
  CANCELLATION_POLICY.freeWindowHours,
  'Contact release must track the free-cancellation window — releasing contact while the customer can still cancel for $0 reopens the off-platform gap',
);

const accepted = extra => ({
  status: 'confirmed',
  assembler_accepted_at: '2026-10-01T12:00:00Z',
  date: DATE,
  time: TIME,
  customer_name: 'Dana R',
  customer_phone: '512-555-0100',
  customer_email: 'dana@example.com',
  address: '1 Real St, Austin, TX 78701',
  details: 'Two dressers',
  ...extra,
});

// ── 1. Open offer — nothing at all ──────────────────────────────────────────
const offer = evaluateCustomerContactRelease(accepted({ assembler_accepted_at: null }), APPT - 2 * HOUR);
assert.equal(offer.scopeVisible, false);
assert.equal(offer.released, false);
assert.equal(offer.code, CONTACT_RELEASE_CODE.NOT_ACCEPTED);

// ── 2. Accepted, appointment days out — scope yes, contact no ───────────────
const early = evaluateCustomerContactRelease(accepted(), APPT - 120 * HOUR);
assert.equal(early.scopeVisible, true, 'an accepted pro must still be able to plan the job');
assert.equal(early.released, false, 'phone must be withheld while the customer can still cancel free');
assert.equal(early.code, CONTACT_RELEASE_CODE.PENDING_LEAD_TIME);
assert.equal(early.releasesAt, new Date(APPT - CONTACT_RELEASE_LEAD_HOURS * HOUR).toISOString());

// ── 3. Boundary — exactly at the window, and one minute before ──────────────
assert.equal(
  evaluateCustomerContactRelease(accepted(), APPT - CONTACT_RELEASE_LEAD_HOURS * HOUR).released,
  true, 'release is inclusive at exactly the lead-time mark');
assert.equal(
  evaluateCustomerContactRelease(accepted(), APPT - CONTACT_RELEASE_LEAD_HOURS * HOUR - 60000).released,
  false, 'one minute before the mark is still withheld');

// ── 4. Inside the window ────────────────────────────────────────────────────
assert.equal(evaluateCustomerContactRelease(accepted(), APPT - 6 * HOUR).released, true);
assert.equal(evaluateCustomerContactRelease(accepted(), APPT + 2 * HOUR).released, true, 'a running-late job keeps contact');

// ── 5. Safety valve — a committed pro is never cut off by the clock ─────────
for (const status of ['en_route', 'arrived', 'in_progress']) {
  const live = evaluateCustomerContactRelease(accepted({ status }), APPT - 500 * HOUR);
  assert.equal(live.released, true, `${status}: a pro already committed must always reach the customer`);
}

// ── 6. Safety valve — unreadable appointment releases rather than strands ───
const broken = evaluateCustomerContactRelease(accepted({ time: 'whenever' }), APPT - 500 * HOUR);
assert.equal(broken.released, true, 'never strand a pro over a malformed slot');
assert.equal(broken.reason, 'appointment_time_unreadable');

// ── 7. Terminal history stays stripped ──────────────────────────────────────
const done = evaluateCustomerContactRelease(accepted({ status: 'completed' }), APPT + 48 * HOUR);
assert.equal(done.scopeVisible, false);
assert.equal(done.released, false);
assert.equal(done.code, CONTACT_RELEASE_CODE.NOT_ACTIVE);

// ── 8. Return visits track the RETURN date, not the original ───────────────
const rv = { status: 'completed', return_visit_required: true, return_visit_date: DATE, return_visit_time: TIME };
assert.equal(evaluateCustomerContactRelease(accepted(rv), APPT - 120 * HOUR).scopeVisible, true, 'open return visit keeps scope');
assert.equal(evaluateCustomerContactRelease(accepted(rv), APPT - 120 * HOUR).released, false, 'return visit contact also waits for its own window');
assert.equal(evaluateCustomerContactRelease(accepted(rv), APPT - 3 * HOUR).released, true, 'return visit releases against the return date');

// ── 9. The redaction chokepoint actually applies the verdict ───────────────
const [held, live] = redactAssignmentCustomerData(
  [accepted(), accepted()],
  APPT - 120 * HOUR,
);
assert.equal(held.customer_phone, null, 'server must not transmit the phone before the window');
assert.equal(held.customer_email, null, 'server must not transmit the email before the window');
assert.equal(held.customer_name, 'Dana R', 'name stays — it is not a contact channel');
assert.equal(held.address, '1 Real St, Austin, TX 78701', 'address stays — the pro plans a route with it');
assert.equal(held.details, 'Two dressers');
assert.equal(held._contact_release.code, CONTACT_RELEASE_CODE.PENDING_LEAD_TIME);
assert.ok(held._contact_release.releasesAt, 'UI needs a real unlock time, never a blank field');
assert.equal(live._contact_release.leadHours, CONTACT_RELEASE_LEAD_HOURS);

const [released] = redactAssignmentCustomerData([accepted()], APPT - 2 * HOUR);
assert.equal(released.customer_phone, '512-555-0100');
assert.equal(released.customer_email, 'dana@example.com');

// ── 10. The UI must render the verdict, never recompute it (Article 4) ─────
const ui = await readFile(new URL('../assembler/my-assignments.html', import.meta.url), 'utf8');
assert.ok(ui.includes('_contact_release'), 'Easer UI must consume the server contact verdict');
assert.equal(
  /assembler_accepted_at\s*&&\s*b\.customer_phone/.test(ui),
  false,
  'UI must not re-derive contact visibility from acceptance — that is the server verdict',
);

// ── 11. Leakage signal — the measurement that proves the gate worked ───────
const DAY = 24 * HOUR;
const nowMs = APPT + 10 * DAY;
const easers = [{ id: 'e1', full_name: 'Pat L' }, { id: 'e2', full_name: 'Sam K' }];

function job(easerId, status, opts = {}) {
  return {
    ref: opts.ref || 'AAE-X', assembler_id: easerId, status,
    assembler_accepted_at: new Date(nowMs - 20 * DAY).toISOString(),
    date: DATE, time: TIME,
    cancelled_at: opts.cancelledAt || null,
  };
}
// Pat: 5 accepted, 3 cancelled while cancelling was still free.
const freeCancel = new Date(APPT - 72 * HOUR).toISOString();
// A cancellation INSIDE the fee window is the opposite of a bargain.
const paidCancel = new Date(APPT - 3 * HOUR).toISOString();
const bookings = [
  job('e1', 'cancelled', { cancelledAt: freeCancel, ref: 'AAE-1' }),
  job('e1', 'cancelled', { cancelledAt: freeCancel, ref: 'AAE-2' }),
  job('e1', 'cancelled', { cancelledAt: freeCancel, ref: 'AAE-3' }),
  job('e1', 'completed'),
  job('e1', 'completed'),
  job('e2', 'cancelled', { cancelledAt: paidCancel, ref: 'AAE-4' }),
  job('e2', 'completed'), job('e2', 'completed'), job('e2', 'completed'),
  // Outside the window entirely — must not count.
  { ...job('e1', 'cancelled', { cancelledAt: freeCancel }), assembler_accepted_at: new Date(nowMs - 400 * DAY).toISOString() },
  // Never accepted by anyone — not this signal's business.
  { ref: 'AAE-9', assembler_id: null, status: 'cancelled', cancelled_at: freeCancel, date: DATE, time: TIME },
];

const signal = computeLeakageSignals({ bookings, easers, nowMs });
const pat = signal.easers.find(e => e.easerId === 'e1');
const sam = signal.easers.find(e => e.easerId === 'e2');
assert.equal(pat.accepted, 5, 'jobs accepted outside the window must not inflate the denominator');
assert.equal(pat.freeCancelAfterAccept, 3);
assert.equal(pat.ratePct, 60);
assert.equal(pat.flagged, true, 'a real pattern above the sample floor is surfaced');
assert.equal(sam.freeCancelAfterAccept, 0, 'a cancellation that cost the customer money is not a side-deal signal');
assert.equal(sam.flagged, false);
assert.equal(signal.flaggedCount, 1);
assert.equal(signal.easers[0].easerId, 'e1', 'flagged rows sort first');

// Small samples are reported but never accused.
const tiny = computeLeakageSignals({
  bookings: [job('e1', 'cancelled', { cancelledAt: freeCancel })],
  easers, nowMs,
});
assert.equal(tiny.easers[0].ratePct, 100);
assert.equal(tiny.easers[0].sampleMeaningful, false);
assert.equal(tiny.easers[0].flagged, false, 'one cancellation is never evidence of anything');

// An unreadable appointment cannot be classified, so it is not counted against
// a real person.
const unreadable = computeLeakageSignals({
  bookings: [
    { ...job('e1', 'cancelled', { cancelledAt: freeCancel }), time: 'sometime' },
    job('e1', 'completed'), job('e1', 'completed'), job('e1', 'completed'),
  ],
  easers, nowMs,
});
assert.equal(unreadable.easers[0].freeCancelAfterAccept, 0, 'never infer a signal from data we could not read');

// ── 12. No email may promise contact the window will not give ─────────────
// The assignment email said "Customer contact and exact address are shown after
// acceptance". Once contact moved to a pre-appointment window that became a
// promise the platform could not keep for a week (Rule 10, no double-talk).
const assignSource = await readFile(new URL('../api/booking/assign.js', import.meta.url), 'utf8');
assert.doesNotMatch(assignSource, /Customer contact and exact address are shown after acceptance/,
  'the assignment email must not promise contact details at acceptance');
assert.match(assignSource, /CONTACT_RELEASE_LEAD_HOURS/,
  'the email must quote the real release window, not restate a number');
assert.match(assignSource, /unlock \$\{CONTACT_RELEASE_LEAD_HOURS\} hours before the job/);

console.log('customer contact release tests: PASS');
