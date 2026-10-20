const HOLD_COPY = {
  offline_payment_not_verified: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  customer_payment_uncaptured: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  cancellation_payment_uncaptured: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  completion_evidence_missing: {
    code: 'action_required',
    label: 'Action Required',
    message: 'Upload a completion photo to continue your payout.',
  },
  refund_review_incomplete: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  damage_review_open: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  damage_review_incomplete: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  customer_dispute_open: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  financial_reconciliation_open: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  return_visit_open: {
    code: 'action_required',
    label: 'Action Required',
    message: 'Complete the remaining work before this amount becomes payable.',
  },
  stripe_connect_path: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  stripe_transfer_exists: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  payout_mode_missing: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  payout_state_reconciliation: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
  easer_not_assigned: {
    code: 'on_hold',
    label: 'On Hold',
    message: "Your payout is temporarily on hold. We'll notify you when its status changes.",
  },
};

const HOLD_PRIORITY = [
  'customer_dispute_open',
  'financial_reconciliation_open',
  'return_visit_open',
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
  const isTransferred = !isPaid
    && !stripeBankPaid
    && rawPayoutStatus === 'transferred'
    && row.payoutDisposition === 'transferred';
  let disposition = row.payoutDisposition || 'on_hold';
  let statusCode = 'on_hold';
  let statusLabel = 'On Hold';
  let statusMessage = "Your payout is temporarily on hold. We'll notify you when its status changes.";

  const connectRailOnlyHold = row.payoutMode === 'stripe_connect'
    && rawPayoutStatus === 'pending'
    && disposition === 'on_hold'
    && holdCodes.length > 0
    && holdCodes.every(code => code === 'stripe_connect_path');
  if (connectRailOnlyHold) disposition = 'pending';

  if (stripeBankPaid) {
    disposition = 'paid';
    statusCode = 'paid';
    statusLabel = 'Paid';
    statusMessage = 'Your payout is complete.';
  } else if (isPaid) {
    disposition = 'paid';
    statusCode = 'paid';
    statusLabel = 'Paid';
    statusMessage = 'Your payout is complete.';
  } else if (isTransferred) {
    disposition = 'transferred';
    statusCode = 'processing';
    statusLabel = 'Processing';
    statusMessage = "Your payout is processing. We'll update this status when it is complete.";
  } else if (disposition === 'pending') {
    statusCode = 'pending';
    statusLabel = 'Pending';
    statusMessage = 'Your payout is ready and waiting to be sent.';
  } else if (disposition === 'not_payable') {
    statusCode = 'unavailable';
    statusLabel = 'Unavailable';
    statusMessage = 'A payout amount is not currently available for this job.';
  } else {
    disposition = 'on_hold';
    const internalHoldCode = primaryHoldCode(holdCodes);
    const copy = HOLD_COPY[internalHoldCode];
    if (copy) {
      statusCode = copy.code;
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
