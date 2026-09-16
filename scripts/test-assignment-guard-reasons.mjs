import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { describeAssignmentGuardFailure } from '../api/booking/_assignment-guard-reasons.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

// ── The exact failure an owner hit ─────────────────────────────────────────
// Assigning a healthy pro to an advance booking raised the payment guard, and
// the owner was told their EASER's readiness had changed.
const paymentGuard = describeAssignmentGuardFailure({
  code: '23514',
  message: 'Customer payment must be verified before assignment or acceptance',
});
assert.equal(paymentGuard.matched, true);
assert.match(paymentGuard.message, /customer's payment, not the Easer's payout setup/);
assert.doesNotMatch(paymentGuard.message, /Easer readiness changed/,
  'a customer-payment guard must never be reported as an Easer-readiness problem');

// ── Each guard reports its own cause, not a shared one ─────────────────────
const distinct = new Set();
for (const [message, code] of [
  ['Customer payment must be verified before assignment or acceptance', 'CUSTOMER_PAYMENT_NOT_VERIFIED'],
  ['Customer payment must be authorized before work begins', 'PAYMENT_NOT_AUTHORIZED_FOR_WORK'],
  ['Saved-card assignment requires its saved Stripe payment method', 'SAVED_CARD_MISSING'],
  ['Authorized assignment requires its linked Stripe PaymentIntent', 'PAYMENT_INTENT_MISSING'],
  ['Deposit assignment requires a valid paid deposit and linked Stripe PaymentIntent', 'DEPOSIT_INVALID'],
  ['A zero-dollar booking cannot be assigned outside an explicit simulation', 'BOOKING_TOTAL_ZERO'],
  ['A negative-price booking cannot be assigned', 'BOOKING_TOTAL_NEGATIVE'],
  ['Assigned Easer is not ready and eligible for jobs', 'EASER_NOT_READY'],
  ['A closure-held Easer cannot receive or retain a live assignment', 'EASER_CLOSURE_HELD'],
  ['Assigned Easer profile not found', 'EASER_PROFILE_MISSING'],
]) {
  const r = describeAssignmentGuardFailure({ code: '23514', message });
  assert.equal(r.code, code, `"${message}" must map to ${code}`);
  assert.equal(r.matched, true);
  assert.ok(r.message.length > 20, 'an owner-facing reason must actually say something');
  distinct.add(r.message);
}
assert.equal(distinct.size, 10, 'ten guards must produce ten distinct owner messages');

// ── An unknown failure says it is unknown; it does not invent a cause ──────
const unknown = describeAssignmentGuardFailure({ code: '23514', message: 'some new guard nobody mapped' });
assert.equal(unknown.matched, false);
assert.match(unknown.message, /reason was not recognised/);
const race = describeAssignmentGuardFailure({ code: '40001', message: 'could not serialize access' });
assert.equal(race.code, 'BOOKING_CHANGED_DURING_ASSIGNMENT');
assert.doesNotMatch(race.message, /serialize/, 'raw driver text must never reach the owner');

// ── EVERY message the assignment trigger can raise must be mapped ──────────
// Article 7's lesson: a rule that lives only in the database is invisible.
// A future migration adding a guard without a mapping regresses this exact bug.
const files = (await readdir(new URL('../api/migrations/', import.meta.url))).sort();
const triggerMigrations = [];
for (const f of files) {
  const sql = await read(`api/migrations/${f}`);
  if (sql.includes('FUNCTION public.guard_booking_easer_closure_assignment')) triggerMigrations.push({ f, sql });
}
assert.ok(triggerMigrations.length, 'the assignment trigger must be defined in a migration');
const latest = triggerMigrations.at(-1);
const raised = [...latest.sql.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map(m => m[1])
  .filter(m => !m.startsWith('Apply migration'));
assert.ok(raised.length >= 10, `expected the full guard set in ${latest.f}, found ${raised.length}`);
for (const message of raised) {
  const r = describeAssignmentGuardFailure({ code: '23514', message });
  assert.equal(r.matched, true,
    `${latest.f} raises "${message}" but _assignment-guard-reasons.js has no mapping — the owner would get the generic refusal`);
}

// ── assign.js must use it, and must not ship the old sentence ─────────────
const assignSrc = await read('api/booking/assign.js');
assert.match(assignSrc, /describeAssignmentGuardFailure\(updateErr\)/);
assert.doesNotMatch(assignSrc, /The booking or Easer readiness changed before assignment/,
  'the message that blamed the wrong party must not come back');

// ── The migration half of PR #163 (Article 7) ─────────────────────────────
const m095 = await read('api/migrations/095_saved_card_may_carry_assignment.sql');
assert.match(m095, /ELSIF NEW\.payment_status = 'card_saved' THEN/,
  'the database must accept a confirmed saved card for assignment');
assert.match(m095, /v_live_work_transition/,
  'a saved card may staff a job but must never start live work');
assert.match(m095, /stripe_payment_method_id IS NULL/,
  'a saved card with no payment method is still refused');
assert.match(m095, /VALUES \(95, 'saved_card_may_carry_assignment'\)/);

console.log('assignment guard reason tests: PASS');
