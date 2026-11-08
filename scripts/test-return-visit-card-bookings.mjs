#!/usr/bin/env node
// A card job that runs into another day (owner, 2026-10-18: AAE-EYXG5NSDUN, a
// 4-TV job past 7:30 PM with no way to record a second day). The owner can now
// schedule a return visit on a card booking whose payment is held, but only to
// a date the card hold still covers; finishing the job closes the return visit.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateAuthorizationWindow, AUTHORIZATION_WINDOW } from '../api/booking/_authorization-window.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// ── Which bookings can continue another day ─────────────────────────────────
const { returnVisitPaymentLane } = await import('../api/owner/schedule-return-visit.js');
assert.equal(returnVisitPaymentLane({ source: 'owner_manual', payment_status: 'offline_recorded' }), 'offline');
assert.equal(returnVisitPaymentLane({ source: 'online', payment_status: 'authorized' }), 'card_hold');
for (const payment_status of ['card_saved', 'pending', 'failed', 'captured', 'refunded']) {
  assert.equal(returnVisitPaymentLane({ source: 'online', payment_status }), null, `${payment_status}: no held card, no return visit`);
}
assert.equal(returnVisitPaymentLane({ source: 'owner_manual', payment_status: 'authorized' }), null, 'owner bookings keep their offline lane');
// Owner, 2026-10-26: a Thumbtack job with its AAE Stripe hold in place was
// refused a return visit as "payment is not held".
const thumbtackHeld = { source: 'owner_manual', external_platform: 'thumbtack', stripe_payment_intent_id: 'pi_test', payment_method: null, payment_status: 'authorized' };
assert.equal(returnVisitPaymentLane(thumbtackHeld), 'card_hold', 'a Thumbtack job with an AAE Stripe hold is a held card booking');
assert.equal(returnVisitPaymentLane({ ...thumbtackHeld, payment_status: 'pending' }), null, 'a Thumbtack hold the customer has not approved is not held');
assert.equal(returnVisitPaymentLane({ ...thumbtackHeld, stripe_payment_intent_id: null }), null, 'no linked Stripe hold, no card lane');
assert.equal(returnVisitPaymentLane({ ...thumbtackHeld, external_platform: null }), null, 'other owner bookings keep their offline lane');
console.log('PASS a return visit is offered for offline owner bookings and held card bookings only');

// ── The hold must still be good when the return visit ends ──────────────────
{
  const held = { payment_status: 'authorized', date: '2026-10-17', time: '10:00 AM - 12:00 PM', authorization_capture_before: '2026-10-21T14:00:00.000Z' };
  const now = Date.parse('2026-10-18T03:00:00Z');
  const ok = evaluateAuthorizationWindow({ ...held, return_visit_required: true, return_visit_date: '2026-10-18', return_visit_time: '10:00 AM - 12:00 PM' }, now);
  assert.equal(ok.ok, true, 'a next-day return inside the hold is allowed');
  const late = evaluateAuthorizationWindow({ ...held, return_visit_required: true, return_visit_date: '2026-10-23', return_visit_time: '10:00 AM - 12:00 PM' }, now);
  assert.equal(late.reason, AUTHORIZATION_WINDOW.EXPIRES_BEFORE_COMPLETION, 'a return after the hold ends is refused');
}
const endpoint = await read('api/owner/schedule-return-visit.js');
assert.match(endpoint, /evaluateAuthorizationWindow\(\{\s*\.\.\.booking,\s*return_visit_required: true,\s*return_visit_date: returnDate,\s*return_visit_time: returnTime,/,
  'the hold is checked against the return date being saved');
assert.match(endpoint, /code: byDeadline \? 'RETURN_VISIT_AFTER_CARD_HOLD'/, 'the refusal names the hold');
assert.match(endpoint, /\.select\('[^']*\bexternal_platform\b[^']*\bstripe_payment_intent_id\b[^']*'\)/,
  'the booking read includes what the Thumbtack card lane is decided on');
// A held card with no recorded deadline is asked of Stripe, not refused.
assert.match(endpoint, /if \(!booking\.authorization_capture_before\) \{\s*booking\.authorization_capture_before = await learnCaptureDeadline\(sb, booking\);/,
  'a missing deadline is learned before the hold is judged');
assert.match(endpoint, /\.is\('authorization_capture_before', null\)/, 'a learned deadline never overwrites a recorded one');
assert.match(await read('api/assembler/stripe-webhook.js'),
  /const liveAuthorization = await stripe\.paymentIntents\.retrieve\(pi\.id, \{ expand: \['latest_charge'\] \}\);/,
  'the authorization webhook reads the charge, so the deadline it saves is real');
{
  const { inspectUnknownAuthorization } = await import('../api/cron/reauth-payments.js');
  const captureBefore = 1793534400; // 2026-11-01T14:00:00Z
  const booking = { id: 'b1', ref: 'AAE-TT1', total_price: 25000, stripe_customer_id: 'cus_1', stripe_payment_intent_id: 'pi_1' };
  const intent = {
    id: 'pi_1', status: 'requires_capture', capture_method: 'manual', amount: 25000, amount_capturable: 25000,
    currency: 'usd', customer: 'cus_1', livemode: false,
    metadata: { bookingId: 'b1', bookingRef: 'AAE-TT1', type: 'customer_booking', leadSource: 'thumbtack' },
    latest_charge: { payment_method_details: { card: { capture_before: captureBefore } } },
  };
  const stripe = { paymentIntents: { retrieve: async () => intent } };
  const seen = await inspectUnknownAuthorization({ stripe, booking, expectedLivemode: false });
  assert.deepEqual(seen, { ok: true, captureBefore: new Date(captureBefore * 1000).toISOString() },
    'a Thumbtack AAE Stripe hold yields its deadline');
  const other = await inspectUnknownAuthorization({ stripe, booking: { ...booking, id: 'b2' }, expectedLivemode: false });
  assert.equal(other.ok, false, "another booking's hold is never read as this one's");
}
assert.match(endpoint, /\.eq\('source', booking\.source\)\s*\.eq\('payment_status', booking\.payment_status\)/,
  'the write re-checks the payment state it was decided on');
assert.match(endpoint, /notificationType: 'return_visit_easer', recipientType: 'easer'/, 'the Easer is told');
console.log('PASS the card hold must cover the return visit, checked at the date being saved');

// ── Finishing the job closes the return visit on every completion path ─────
for (const rel of ['api/booking/assembler-complete.js', 'api/booking/complete.js']) {
  const src = await read(rel);
  const online = src.slice(src.indexOf('const completionPayload = {'), src.indexOf('if (actualStripeFee != null) completionPayload.stripe_fee'));
  assert.match(online, /payment_status: 'captured'/, `${rel}: this is the card completion`);
  assert.match(online, /return_visit_required: false,/, `${rel}: card completion closes the return visit`);
  assert.match(online, /return_visit_completed_at: booking\.return_visit_required \?/, `${rel}: and records when`);
}
console.log('PASS Easer and owner card completions close any open return visit');

// ── The owner can reach it; the Easer inbox can name it ─────────────────────
const owner = await read('owner/index.html');
assert.match(owner, /if \(b\.payment_status === 'authorized'\) \{[\s\S]{0,900}data-action="schedule-return-visit"/,
  'the owner sees Schedule Return Visit on a held card booking');
assert.match(await read('api/assembler/notifications.js'), /return_visit_easer: notice\(/);
console.log('PASS owner action and Easer inbox wording');

console.log('\nReturn visit for card bookings tests passed.');
