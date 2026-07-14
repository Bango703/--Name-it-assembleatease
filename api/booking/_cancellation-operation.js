export const OWNER_CANCELLATION_TAKEOVER_DELAY_MS = 5 * 60 * 1000;

function conflict(message) {
  const error = new Error(message);
  error.code = 'FINANCIAL_OPERATION_CONFLICT';
  return error;
}

export function cancellationPolicyEvaluationTimeMs(booking, fallbackNowMs = Date.now()) {
  const expectedKeysByType = {
    cancel_owner: `cancel:owner:${booking.id}`,
    cancel_customer: `cancel:customer:${booking.id}`,
    cancel_guest: `cancel:guest:${booking.id}`,
  };
  const expectedKey = expectedKeysByType[booking.financial_operation_type];
  const startedAtMs = Date.parse(booking.financial_operation_started_at || '');
  return expectedKey
    && booking.financial_operation_key === expectedKey
    && Number.isFinite(startedAtMs)
    ? startedAtMs
    : fallbackNowMs;
}

export function resolveOwnerCancellationReservation(booking, nowMs = Date.now()) {
  const ownerKey = `cancel:owner:${booking.id}`;
  const currentKey = booking.financial_operation_key || null;
  const currentType = booking.financial_operation_type || null;

  if (!currentKey && !currentType) {
    return { operationKey: ownerKey, operationType: 'cancel_owner', takeover: false };
  }
  if (currentKey === ownerKey && currentType === 'cancel_owner') {
    return { operationKey: ownerKey, operationType: 'cancel_owner', takeover: false };
  }

  const customerKey = `cancel:customer:${booking.id}`;
  const guestKey = `cancel:guest:${booking.id}`;
  const isCustomerCancellation = currentKey === customerKey && currentType === 'cancel_customer';
  const isGuestCancellation = currentKey === guestKey && currentType === 'cancel_guest';
  if (!isCustomerCancellation && !isGuestCancellation) {
    throw conflict('Another booking or payment action is already in progress. Refresh before trying again.');
  }
  if (booking.dispatch_status !== 'payment_hold' || booking.dispatch_paused !== true) {
    throw conflict('The customer cancellation has not reached a safe owner-recovery state. Refresh before trying again.');
  }

  const startedAtMs = Date.parse(booking.financial_operation_started_at || '');
  const reconciliationAtMs = Date.parse(booking.cancellation_reconciliation_required_at || '');
  if (!Number.isFinite(startedAtMs)
      || !Number.isFinite(reconciliationAtMs)
      || !Number.isFinite(nowMs)
      || nowMs - startedAtMs < OWNER_CANCELLATION_TAKEOVER_DELAY_MS
      || nowMs - reconciliationAtMs < OWNER_CANCELLATION_TAKEOVER_DELAY_MS) {
    throw conflict('The customer cancellation is still being reconciled. Wait five minutes, refresh, and retry from the owner dashboard.');
  }

  return {
    operationKey: ownerKey,
    operationType: 'cancel_owner',
    takeover: true,
    expectedOperationKey: currentKey,
  };
}

export async function assertCancellationPayoutUnsettled(sb, booking) {
  const bookingShowsSettledPayout = ['paid', 'transferred'].includes(String(booking.payout_status || '').toLowerCase())
    || ['paid', 'transferred'].includes(String(booking.cancellation_easer_payout_status || '').toLowerCase())
    || !!booking.stripe_transfer_id
    || Number(booking.payout_amount || 0) > 0
    || !!booking.paid_out_at;

  const { count, error } = await sb.from('payout_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('booking_id', booking.id);
  if (error) {
    const payoutTruthError = new Error('Payout history could not be verified. No cancellation payment action was attempted.');
    payoutTruthError.code = 'CANCELLATION_PAYOUT_TRUTH_UNAVAILABLE';
    throw payoutTruthError;
  }
  if (bookingShowsSettledPayout || Number(count || 0) > 0) {
    const payoutConflict = new Error('This booking already has Easer payout activity. Reconcile the payout or clawback before changing customer payment state.');
    payoutConflict.code = 'CANCELLATION_PAYOUT_RECONCILIATION_REQUIRED';
    throw payoutConflict;
  }
  return true;
}

export async function hasDurableCancellationFeeCaptureAudit(sb, {
  booking,
  paymentIntentId,
  feeCents,
} = {}) {
  const keys = ['owner', 'customer', 'guest']
    .map(actor => `${actor}-cancel-fee-${booking.id}-${feeCents}`);
  const { data, error } = await sb.from('financial_event_audit')
    .select('id')
    .eq('booking_id', booking.id)
    .eq('payment_intent_id', paymentIntentId)
    .eq('event_type', 'capture_attempt')
    .eq('status', 'processed')
    .in('idempotency_key', keys)
    .limit(1);
  if (error) {
    const auditError = new Error('Cancellation fee audit history could not be verified. Owner payment reconciliation is required.');
    auditError.code = 'FINANCIAL_AUDIT_TRUTH_UNAVAILABLE';
    throw auditError;
  }
  return !!data?.length;
}
