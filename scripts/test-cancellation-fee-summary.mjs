#!/usr/bin/env node
// AAE-TYRHONCHIO, 2026-09-29: cancelled on the day of the job with no Easer
// accepted. $0 was correct. But the owner email said "No fee charged (24h+
// notice)", and the tracking page ran its own copy of the fee policy with no
// "no Easer accepted" rule, so it could warn a customer of a fee the server
// would never charge. Every surface was explaining the fee with a reason it
// had worked out for itself.
//
// Now: computeCancellationFee() returns `reason`; evaluateCancellationPolicy()
// is the one place a booking's inputs are gathered; every surface renders
// those. This test holds that shut.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeCancellationFee, CANCELLATION_POLICY } from '../api/_source-of-truth.js';
import { evaluateCancellationPolicy } from '../api/booking/_cancellation-policy-truth.js';
import {
  CANCELLATION_REASONS,
  cancellationFeeSummary,
  cancellationFeeSummaryHtml,
  cancellationPreview,
  customerCancellationMessage,
  customerCancellationResult,
} from '../api/booking/_cancellation-fee-summary.js';

const sub = 20000; // $200 service subtotal

// 1. The fee math is unchanged. Reference model = the policy as it was before
//    `reason` existed; every combination must give the same tier and fee.
function reference({ h, status, isNoShow, forfeit, accepted }) {
  if (accepted !== true) return { tier: 'free', feeCents: 0 };
  const committed = ['en_route', 'arrived', 'in_progress'].includes(status);
  let tier, pct;
  if (isNoShow || committed || (h != null && h < CANCELLATION_POLICY.imminentWindowHours)) { tier = 'imminent'; pct = CANCELLATION_POLICY.imminentFeePct; }
  else if (h != null && h < CANCELLATION_POLICY.freeWindowHours) { tier = 'late'; pct = CANCELLATION_POLICY.lateFeePct; }
  else { tier = 'free'; pct = 0; }
  if (forfeit && tier === 'free') { tier = 'late'; pct = CANCELLATION_POLICY.lateFeePct; }
  return { tier, feeCents: Math.round(sub * pct / 100) };
}
let combos = 0;
for (const h of [null, -1, 0.5, 1.99, 2, 10, 23.9, 24, 30, 200]) {
  for (const status of ['confirmed', 'pending', 'en_route', 'arrived', 'in_progress']) {
    for (const isNoShow of [false, true]) for (const forfeit of [false, true]) for (const accepted of [false, true, undefined]) {
      const got = computeCancellationFee({ serviceSubtotalCents: sub, hoursUntilAppointment: h, status, isNoShow, forfeitFreeWindow: forfeit, easerAccepted: accepted });
      const want = reference({ h, status, isNoShow, forfeit, accepted });
      assert.equal(got.tier, want.tier, JSON.stringify({ h, status, isNoShow, forfeit, accepted }));
      assert.equal(got.feeCents, want.feeCents, JSON.stringify({ h, status, isNoShow, forfeit, accepted }));
      assert.ok(CANCELLATION_REASONS.includes(got.reason), `unknown reason ${got.reason}`);
      combos++;
    }
  }
}

// 2. Each reason is the true cause.
const R = (args) => computeCancellationFee({ serviceSubtotalCents: sub, status: 'confirmed', easerAccepted: true, ...args }).reason;
assert.equal(computeCancellationFee({ serviceSubtotalCents: sub, hoursUntilAppointment: 3, status: 'confirmed', easerAccepted: false }).reason, 'no_easer_accepted');
assert.equal(R({ hoursUntilAppointment: 30 }), 'free_window');
assert.equal(R({ hoursUntilAppointment: null }), 'notice_unknown');
assert.equal(R({ hoursUntilAppointment: 10 }), 'late_window');
assert.equal(R({ hoursUntilAppointment: 30, forfeitFreeWindow: true }), 'rescheduled');
assert.equal(R({ hoursUntilAppointment: 1 }), 'imminent_window');
assert.equal(R({ hoursUntilAppointment: 10, status: 'en_route' }), 'pro_committed');
assert.equal(R({ hoursUntilAppointment: 10, isNoShow: true }), 'no_show');

// 3. Every reason has words for the customer and the owner; unknown reasons fail loudly.
for (const reason of CANCELLATION_REASONS) {
  const policy = { tier: 'late', feePct: 10, feeCents: 0, reason };
  assert.ok(customerCancellationMessage(policy).length > 10, reason);
  assert.ok(cancellationFeeSummary({ policy }).text.length > 10, reason);
}
assert.throws(() => customerCancellationMessage({ reason: 'guess' }));
assert.throws(() => cancellationFeeSummary({ policy: { tier: 'free', feeCents: 0 } }), 'a policy without a reason must not be explained');

// 4. Angela's booking: same day, no Easer accepted. Preview, charge and emails agree.
{
  const now = Date.parse('2026-09-29T15:00:00-05:00');
  const booking = { id: 'b1', date: '2026-09-29', time: '4:00 PM - 6:00 PM', status: 'confirmed', total_price: 21000, tax_amount: 1000, service_call_fee: 0, assembler_id: null, assembler_accepted_at: null, reschedule_count: 0 };
  const { policy, hoursAway } = evaluateCancellationPolicy(booking, { nowMs: now });
  assert.equal(policy.feeCents, 0);
  assert.equal(policy.reason, 'no_easer_accepted');
  const preview = cancellationPreview(policy);
  assert.equal(preview.fee_cents, 0);
  assert.equal(preview.message, 'Cancellation is free for this booking.');
  const owner = cancellationFeeSummary({ policy, feeCaptured: 0, hoursAway });
  assert.match(owner.text, /no Easer had accepted/);
  assert.doesNotMatch(owner.text, /24/);
  assert.equal(customerCancellationResult({ policy, feeCaptured: 0, holdReleased: false }), 'Your booking is cancelled at no charge.');
}

// 5. Same booking with an accepted Easer: late fee, and every surface says 10% for the same reason.
{
  const now = Date.parse('2026-09-29T08:00:00-05:00');
  const booking = { id: 'b2', date: '2026-09-29', time: '4:00 PM - 6:00 PM', status: 'confirmed', total_price: 21000, tax_amount: 1000, service_call_fee: 0, assembler_id: 'e1', assembler_accepted_at: '2026-09-28T10:00:00Z', reschedule_count: 0 };
  const { policy } = evaluateCancellationPolicy(booking, { nowMs: now });
  assert.equal(policy.reason, 'late_window');
  assert.equal(policy.feeCents, 2000);
  assert.match(cancellationPreview(policy).message, /within 24 hours, so a 10% fee applies/);
  assert.match(customerCancellationResult({ policy, feeCaptured: 2000, holdReleased: true }), /^A cancellation fee of \$20\.00 was charged\. Your appointment is within 24 hours/);
  const owed = cancellationFeeSummary({ policy, feeCaptured: 0, hoursAway: 8 });
  assert.equal(owed.needsAction, true, 'a fee owed but not collected must be flagged');
  assert.match(cancellationFeeSummaryHtml({ policy, feeCaptured: 0, hoursAway: 8 }), /Action needed/);
  // "hold released" is only said when there was a hold
  assert.doesNotMatch(customerCancellationResult({ policy, feeCaptured: 0, holdReleased: false }), /hold/);
}

// 6. Structure: one evaluation, rendered everywhere; no surface computes its own.
const read = (f) => readFileSync(f, 'utf8');
for (const f of ['api/booking/guest-cancel.js', 'api/booking/customer-cancel.js', 'api/booking/cancel.js', 'api/booking/track.js']) {
  const src = read(f);
  assert.match(src, /evaluateCancellationPolicy\(booking/, `${f} must use the shared evaluation`);
  assert.doesNotMatch(src, /computeCancellationFee\(/, `${f} must not evaluate the policy itself`);
  assert.doesNotMatch(src, /24h\+ notice/, `${f} invents the 24h reason`);
}
for (const f of ['api/booking/guest-cancel.js', 'api/booking/customer-cancel.js']) {
  const src = read(f);
  assert.match(src, /cancellationFeeSummaryHtml\(\{ policy, feeCaptured, hoursAway \}\)/, `${f} owner email must use the shared summary`);
  assert.match(src, /customerCancellationResult\(\{ policy, feeCaptured, holdReleased: stripeMutationRequired \}\)/, `${f} customer copy must use the shared result`);
  assert.doesNotMatch(src, /applies because this cancellation was within 24 hours|because this was within 24 hours/, `${f} still writes its own reason`);
}
const track = read('track.html');
assert.doesNotMatch(track, /cancelFeeClient|pct = 1[05]\b|feePct\s*=/, 'track.html must not compute a cancellation fee');
assert.doesNotMatch(track, /more than 24 hours away — cancellation is free/, 'track.html must not guess the free reason');
assert.match(track, /cancellation_preview/, 'track.html renders the server preview');
assert.match(read('api/booking/track.js'), /cancellation_preview: cancellationPreviewPayload/);

console.log(`PASS cancellation truth: fee math unchanged across ${combos} combinations, one reason per outcome, one evaluation used by guest/customer/owner cancel and the tracking preview.`);
