// The words for a cancellation fee, for the customer and for the owner.
//
// The fee AND its reason come from one place: computeCancellationFee() in
// api/_source-of-truth.js returns `reason`. This module only turns that code
// into sentences. It never works out a reason of its own.
//
// Why: AAE-TYRHONCHIO was cancelled on the day of the job with no Easer
// accepted. The owner email said "No fee charged (24h+ notice)" and the
// tracking page's own copy of the policy had no "no Easer accepted" rule, so
// both explained a $0 outcome with a guessed cause (Article 16), and the page
// could quote a fee the server would never charge (Article 3).

import { esc } from '../_email.js';

export const CANCELLATION_REASONS = Object.freeze([
  'no_easer_accepted',
  'free_window',
  'notice_unknown',
  'late_window',
  'rescheduled',
  'imminent_window',
  'pro_committed',
  'no_show',
]);

const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const ON_SUBTOTAL = 'on the service subtotal, no tax';

function assertReason(policy) {
  if (!policy || !CANCELLATION_REASONS.includes(policy.reason)) {
    throw new Error(`Cancellation fee reason missing or unknown: ${policy && policy.reason}`);
  }
}

// What the customer is told before and after cancelling.
export function customerCancellationMessage(policy) {
  assertReason(policy);
  const pct = policy.feePct;
  switch (policy.reason) {
    case 'no_easer_accepted':
    case 'notice_unknown':
      return 'Cancellation is free for this booking.';
    case 'free_window':
      return 'Your appointment is more than 24 hours away, so cancellation is free.';
    case 'late_window':
      return `Your appointment is within 24 hours, so a ${pct}% fee applies (${ON_SUBTOTAL}).`;
    case 'rescheduled':
      return `This booking was rescheduled, so a ${pct}% fee applies (${ON_SUBTOTAL}).`;
    case 'imminent_window':
      return `Your appointment is within 2 hours, so a ${pct}% fee applies (${ON_SUBTOTAL}).`;
    case 'pro_committed':
      return `Your pro is already on the way, so a ${pct}% fee applies (${ON_SUBTOTAL}).`;
    case 'no_show':
      return `The appointment was missed, so a ${pct}% fee applies (${ON_SUBTOTAL}).`;
    default:
      throw new Error(`Unhandled cancellation reason: ${policy.reason}`);
  }
}

// What the customer is told after cancelling (email and tracking page).
// `holdReleased` is the fact: a card authorization existed and was released.
export function customerCancellationResult({ policy, feeCaptured = 0, holdReleased = false }) {
  assertReason(policy);
  const captured = Number(feeCaptured || 0);
  if (captured > 0) {
    return `A cancellation fee of ${dollars(captured)} was charged. ${customerCancellationMessage(policy)}${holdReleased ? ' The rest of your card hold has been released.' : ''}`;
  }
  return `Your booking is cancelled at no charge.${holdReleased ? ' Your card hold has been released in full.' : ''}`;
}

// The preview the tracking page renders. Built on the server from the rule.
export function cancellationPreview(policy) {
  assertReason(policy);
  return {
    fee_cents: policy.feeCents,
    fee_pct: policy.feePct,
    tier: policy.tier,
    reason: policy.reason,
    message: customerCancellationMessage(policy),
  };
}

function noticeText(hoursAway) {
  if (typeof hoursAway !== 'number' || !Number.isFinite(hoursAway)) return null;
  return hoursAway >= 1 ? `${Math.round(hoursAway)} hours` : 'under 1 hour';
}

// What the owner is told after a cancellation. `feeCaptured` is the fact from
// Stripe (what was actually collected), the policy is the decision.
export function cancellationFeeSummary({ policy, feeCaptured = 0, hoursAway = null }) {
  assertReason(policy);
  const owed = Number(policy.feeCents || 0);
  const captured = Number(feeCaptured || 0);
  const notice = noticeText(hoursAway);
  const noticeSuffix = notice ? ` Notice given: ${notice}.` : '';

  if (captured > 0) {
    return { text: `Cancellation fee of ${dollars(captured)} (${policy.feePct}% ${policy.tier} tier, reason: ${policy.reason.replace(/_/g, ' ')}) charged.${noticeSuffix}`, needsAction: false };
  }
  if (owed > 0) {
    return {
      text: `A ${dollars(owed)} cancellation fee (${policy.feePct}% ${policy.tier} tier, reason: ${policy.reason.replace(/_/g, ' ')}) was owed but was NOT charged: there was no card hold to collect it from.${noticeSuffix} Decide whether to collect it.`,
      needsAction: true,
    };
  }
  switch (policy.reason) {
    case 'no_easer_accepted':
      return { text: `No fee charged: no Easer had accepted this job.${noticeSuffix}`, needsAction: false };
    case 'free_window':
      return { text: `No fee charged: cancelled with ${notice || '24+ hours'} notice.`, needsAction: false };
    case 'notice_unknown':
      return { text: 'No fee charged: the appointment time could not be read, so no fee was applied.', needsAction: false };
    default:
      // A fee reason with a $0 fee means a $0 subtotal; say exactly that.
      return { text: `No fee charged: the ${policy.tier} tier applied (${policy.reason.replace(/_/g, ' ')}) but the service subtotal was $0.${noticeSuffix}`, needsAction: false };
  }
}

export function cancellationFeeSummaryHtml(args) {
  const { text, needsAction } = cancellationFeeSummary(args);
  return needsAction
    ? `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 14px;color:#991b1b"><strong>Action needed:</strong> ${esc(text)}</p>`
    : `<p>${esc(text)}</p>`;
}
