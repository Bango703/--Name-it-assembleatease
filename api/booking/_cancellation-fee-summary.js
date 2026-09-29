// The one sentence the owner reads about the money on a cancellation.
//
// Both cancel paths used to print "No fee charged (24h+ notice)" for every
// $0 outcome. AAE-TYRHONCHIO was cancelled on the day of the job and the
// owner was told it had 24 hours' notice. A $0 cancellation has three
// different causes and one of them is money the business is owed:
//   - no Easer had accepted the job (policy: no fee, waivedReason)
//   - the customer gave 24h+ notice (policy tier 'free')
//   - a fee was owed but there was no card hold to capture it from
// Article 16: state the real cause, never a guessed one.

import { esc } from '../_email.js';

export function cancellationFeeSummary({ policy, feeCaptured = 0, hoursAway = null }) {
  const owed = Number(policy?.feeCents || 0);
  const captured = Number(feeCaptured || 0);
  const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
  const notice = typeof hoursAway === 'number' && Number.isFinite(hoursAway)
    ? (hoursAway >= 1 ? `${Math.round(hoursAway)} hours` : 'under 1 hour')
    : null;

  if (captured > 0) {
    return {
      text: `Cancellation fee of ${dollars(captured)} (${policy.feePct}% ${policy.tier} tier) charged.`,
      needsAction: false,
    };
  }
  if (owed > 0) {
    return {
      text: `A ${dollars(owed)} cancellation fee (${policy.feePct}% ${policy.tier} tier) was owed but was NOT charged: there was no card hold to collect it from.${notice ? ` Notice given: ${notice}.` : ''} Decide whether to collect it.`,
      needsAction: true,
    };
  }
  if (policy?.waivedReason === 'no_easer_accepted') {
    return {
      text: `No fee charged: no Easer had accepted this job.${notice ? ` Notice given: ${notice}.` : ''}`,
      needsAction: false,
    };
  }
  return {
    text: notice ? `No fee charged: cancelled with ${notice} notice.` : 'No fee charged under the cancellation policy.',
    needsAction: false,
  };
}

export function cancellationFeeSummaryHtml(args) {
  const { text, needsAction } = cancellationFeeSummary(args);
  return needsAction
    ? `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 14px;color:#991b1b"><strong>Action needed:</strong> ${esc(text)}</p>`
    : `<p>${esc(text)}</p>`;
}
