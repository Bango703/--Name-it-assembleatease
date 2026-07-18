const HOLD_COPY = {
  offline_payment_not_verified: {
    label: 'Payment Verification',
    message: 'The customer payment has not yet been recorded as collected. AssembleAtEase is reviewing this earning.',
  },
  customer_payment_uncaptured: {
    label: 'Payment Verification',
    message: 'The customer payment is still being verified before this earning can be released.',
  },
  cancellation_payment_uncaptured: {
    label: 'Payment Verification',
    message: 'The customer cancellation payment is still being verified before this earning can be released.',
  },
  completion_evidence_missing: {
    label: 'Photo Required',
    message: 'A current completion photo is required before this earning can be released.',
  },
  refund_review_incomplete: {
    label: 'Owner Review',
    message: 'AssembleAtEase is reviewing this earning after a customer refund.',
  },
  damage_review_open: {
    label: 'Owner Review',
    message: 'AssembleAtEase is reviewing a reported job issue before releasing this earning.',
  },
  damage_review_incomplete: {
    label: 'Owner Review',
    message: 'AssembleAtEase is finishing the documented job review before releasing this earning.',
  },
  customer_dispute_open: {
    label: 'Payment Review',
    message: 'This earning is on hold while a customer payment dispute is reviewed.',
  },
  financial_reconciliation_open: {
    label: 'Payment Review',
    message: 'AssembleAtEase is reconciling the payment record before releasing this earning.',
  },
  stripe_connect_path: {
    label: 'Transfer Review',
    message: 'This earning is assigned to Stripe Connect and its transfer status is being verified.',
  },
  stripe_transfer_exists: {
    label: 'Transfer Review',
    message: 'A Stripe transfer exists and its bank payout status is being verified.',
  },
  payout_mode_missing: {
    label: 'Payment Review',
    message: 'AssembleAtEase is reconciling the payout method for this earning.',
  },
  payout_state_reconciliation: {
    label: 'Payment Review',
    message: 'AssembleAtEase is reconciling the payout record for this earning.',
  },
  easer_not_assigned: {
    label: 'Account Review',
    message: 'AssembleAtEase is reconciling this earning with your Easer account.',
  },
};

const HOLD_PRIORITY = [
  'customer_dispute_open',
  'financial_reconciliation_open',
  'damage_review_open',
  'damage_review_incomplete',
  'refund_review_incomplete',
  'offline_payment_not_verified',
  'customer_payment_uncaptured',
  'cancellation_payment_uncaptured',
  'completion_evidence_missing',
  'stripe_transfer_exists',
  'stripe_connect_path',
  'payout_mode_missing',
  'payout_state_reconciliation',
  'easer_not_assigned',
];

function primaryHoldCode(codes = []) {
  return HOLD_PRIORITY.find(code => codes.includes(code)) || codes[0] || 'payment_review';
}

export function toEaserEarningDto(row = {}) {
  const rawPayoutStatus = String(row.payoutStatus || '').trim().toLowerCase();
  const holdCodes = Array.isArray(row.payoutHoldCodes) ? row.payoutHoldCodes.filter(Boolean) : [];
  const stripeBankPaid = rawPayoutStatus === 'transferred'
    && String(row.stripeBankPayoutStatus || '').toLowerCase() === 'paid'
    && Boolean(row.stripeBankPayoutPaidAt);
  const isPaid = row.paidOut === true || rawPayoutStatus === 'paid';
  const isTransferred = !isPaid && !stripeBankPaid && rawPayoutStatus === 'transferred';
  let disposition = row.payoutDisposition || 'on_hold';
  let statusCode = 'payment_review';
  let statusLabel = 'Payment Review';
  let statusMessage = 'AssembleAtEase is verifying this earning. Refresh later for the current payout status.';

  const connectRailOnlyHold = row.payoutMode === 'stripe_connect'
    && rawPayoutStatus === 'pending'
    && disposition === 'on_hold'
    && holdCodes.length > 0
    && holdCodes.every(code => code === 'stripe_connect_path');
  if (connectRailOnlyHold) disposition = 'pending';

  if (stripeBankPaid) {
    disposition = 'paid';
    statusCode = 'bank_payout_paid';
    statusLabel = 'Bank Payout Paid';
    statusMessage = 'Stripe reports that the bank payout completed.';
  } else if (isPaid) {
    disposition = 'paid';
    statusCode = 'paid';
    statusLabel = 'Paid';
    statusMessage = row.paidOutAt
      ? 'AssembleAtEase recorded this external payout.'
      : 'This payout is recorded as paid.';
  } else if (isTransferred) {
    disposition = 'transferred';
    statusCode = 'bank_payout_pending';
    statusLabel = 'Bank Payout Pending';
    statusMessage = 'Funds were transferred to Stripe, but the bank payout is not yet verified as paid.';
  } else if (disposition === 'pending') {
    statusCode = row.payoutMode === 'stripe_connect' ? 'stripe_transfer_pending' : 'manual_payout_ready';
    statusLabel = row.payoutMode === 'stripe_connect' ? 'Transfer Pending' : 'Ready for Manual Payout';
    statusMessage = row.payoutMode === 'stripe_connect'
      ? 'This earning is ready for its Stripe Connect transfer.'
      : 'This earning is ready for AssembleAtEase to send through your selected external payout method.';
  } else if (disposition === 'not_payable') {
    statusCode = 'amount_not_available';
    statusLabel = 'Amount Not Available';
    statusMessage = 'No payable Easer amount is currently recorded for this item.';
  } else {
    disposition = 'on_hold';
    statusCode = primaryHoldCode(holdCodes);
    const copy = HOLD_COPY[statusCode];
    if (copy) {
      statusLabel = copy.label;
      statusMessage = copy.message;
    }
  }

  return {
    booking_id: row.bookingId,
    booking_ref: row.ref,
    service: row.service || 'Service',
    earning_type: row.cancellationEarnings ? 'cancellation_earnings' : 'completed_job',
    earned_at: row.eventAt || row.completedAt || row.cancelledAt || row.date || null,
    amount_cents: Number(row.owed || row.payoutAmount || 0),
    payout: {
      rail: row.payoutMode === 'stripe_connect'
        ? 'stripe_connect'
        : (row.payoutMode === 'manual' ? 'manual' : 'unverified'),
      disposition,
      status_code: statusCode,
      status_label: statusLabel,
      status_message: statusMessage,
      action: holdCodes.includes('completion_evidence_missing') ? 'upload_completion_evidence' : 'none',
      recorded_at: stripeBankPaid
        ? row.stripeBankPayoutPaidAt
        : (isPaid ? (row.paidOutAt || null) : null),
    },
  };
}

export function summarizeEaserEarnings(earnings = []) {
  return earnings.reduce((summary, earning) => {
    const amount = Number(earning.amount_cents || 0);
    summary.total_earned_cents += amount;
    if (earning.earning_type === 'completed_job') summary.completed_jobs += 1;
    if (earning.payout.disposition === 'paid') summary.paid_cents += amount;
    else if (earning.payout.disposition === 'on_hold') summary.on_hold_cents += amount;
    else if (['pending', 'transferred'].includes(earning.payout.disposition)) {
      summary.awaiting_payout_cents += amount;
    }
    return summary;
  }, {
    completed_jobs: 0,
    total_earned_cents: 0,
    paid_cents: 0,
    awaiting_payout_cents: 0,
    on_hold_cents: 0,
  });
}
