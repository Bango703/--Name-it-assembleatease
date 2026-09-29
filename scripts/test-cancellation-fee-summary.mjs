#!/usr/bin/env node
// AAE-TYRHONCHIO, 2026-09-29: cancelled on the day of the job, and the owner
// email said "No fee charged (24h+ notice)". Both cancel paths printed that for
// every $0 outcome. The real causes differ, and one of them is a fee the
// business is owed but did not collect. This runs the real fee policy through
// the owner wording and checks each cause is named correctly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeCancellationFee } from '../api/_source-of-truth.js';
import { cancellationFeeSummary, cancellationFeeSummaryHtml } from '../api/booking/_cancellation-fee-summary.js';

const sub = 20000; // $200 service subtotal

// Same-day, no Easer accepted: $0, and the reason is the Easer, not notice
{
  const policy = computeCancellationFee({ serviceSubtotalCents: sub, hoursUntilAppointment: 3, status: 'confirmed', easerAccepted: false });
  const s = cancellationFeeSummary({ policy, feeCaptured: 0, hoursAway: 3 });
  assert.match(s.text, /no Easer had accepted/);
  assert.doesNotMatch(s.text, /24/);
  assert.equal(s.needsAction, false);
}

// 30 hours out, Easer accepted: free window, says the real notice
{
  const policy = computeCancellationFee({ serviceSubtotalCents: sub, hoursUntilAppointment: 30, status: 'confirmed', easerAccepted: true });
  const s = cancellationFeeSummary({ policy, feeCaptured: 0, hoursAway: 30 });
  assert.equal(s.text, 'No fee charged: cancelled with 30 hours notice.');
}

// Same-day, Easer accepted, fee captured
{
  const policy = computeCancellationFee({ serviceSubtotalCents: sub, hoursUntilAppointment: 10, status: 'confirmed', easerAccepted: true });
  assert.ok(policy.feeCents > 0);
  const s = cancellationFeeSummary({ policy, feeCaptured: policy.feeCents, hoursAway: 10 });
  assert.match(s.text, /charged\.$/);
  assert.equal(s.needsAction, false);
}

// Same-day, Easer accepted, fee owed but no hold: must be flagged, never "no fee"
{
  const policy = computeCancellationFee({ serviceSubtotalCents: sub, hoursUntilAppointment: 10, status: 'confirmed', easerAccepted: true });
  const s = cancellationFeeSummary({ policy, feeCaptured: 0, hoursAway: 10 });
  assert.equal(s.needsAction, true);
  assert.match(s.text, /was owed but was NOT charged/);
  assert.match(cancellationFeeSummaryHtml({ policy, feeCaptured: 0, hoursAway: 10 }), /Action needed/);
}

// Unknown timing never guesses a notice period
{
  const policy = computeCancellationFee({ serviceSubtotalCents: sub, hoursUntilAppointment: null, status: 'confirmed', easerAccepted: true });
  const s = cancellationFeeSummary({ policy, feeCaptured: 0, hoursAway: null });
  assert.doesNotMatch(s.text, /hours notice|24/);
}

// Both cancel paths use the shared wording; the invented cause is gone
for (const f of ['api/booking/guest-cancel.js', 'api/booking/customer-cancel.js']) {
  const src = readFileSync(f, 'utf8');
  assert.doesNotMatch(src, /24h\+ notice/, `${f} still invents the 24h reason`);
  assert.match(src, /cancellationFeeSummaryHtml\(\{ policy, feeCaptured, hoursAway \}\)/, `${f} must use the shared summary`);
}

console.log('PASS cancellation fee summary: real cause named for every $0 outcome, owed-but-uncollected fee flagged.');
