export function buildBookingFinancialSnapshot(expectedBooking) {
  return expectedBooking ? {
    payment_status: expectedBooking.payment_status ?? null,
    total_price: expectedBooking.total_price ?? null,
    tax_amount: expectedBooking.tax_amount ?? null,
    service_call_fee: expectedBooking.service_call_fee ?? null,
    amount_charged: expectedBooking.amount_charged ?? null,
    refund_amount: expectedBooking.refund_amount ?? null,
    is_deposit: expectedBooking.is_deposit ?? null,
    deposit_amount: expectedBooking.deposit_amount ?? null,
    cancellation_fee: expectedBooking.cancellation_fee ?? null,
    stripe_customer_id: expectedBooking.stripe_customer_id ?? null,
    stripe_payment_intent_id: expectedBooking.stripe_payment_intent_id ?? null,
    stripe_deposit_intent_id: expectedBooking.stripe_deposit_intent_id ?? null,
    stripe_balance_payment_intent_id: expectedBooking.stripe_balance_payment_intent_id ?? null,
    stripe_balance_amount_captured: expectedBooking.stripe_balance_amount_captured ?? null,
    payout_status: expectedBooking.payout_status ?? null,
    payout_amount: expectedBooking.payout_amount ?? null,
    payout_mode_snapshot: expectedBooking.payout_mode_snapshot ?? null,
    payout_review_status: expectedBooking.payout_review_status ?? null,
    payout_reviewed_at: expectedBooking.payout_reviewed_at ?? null,
    payout_reviewed_by: expectedBooking.payout_reviewed_by ?? null,
    payout_review_notes: expectedBooking.payout_review_notes ?? null,
    evidence_requested_at: expectedBooking.evidence_requested_at ?? null,
    job_started_at: expectedBooking.job_started_at ?? null,
    damage_review_status: expectedBooking.damage_review_status ?? null,
    damage_claim_opened_at: expectedBooking.damage_claim_opened_at ?? null,
    damage_reviewed_at: expectedBooking.damage_reviewed_at ?? null,
    damage_reviewed_by: expectedBooking.damage_reviewed_by ?? null,
    damage_review_notes: expectedBooking.damage_review_notes ?? null,
    paid_out_at: expectedBooking.paid_out_at ?? null,
    stripe_transfer_id: expectedBooking.stripe_transfer_id ?? null,
    assembler_due: expectedBooking.assembler_due ?? null,
    cancellation_easer_payout_status: expectedBooking.cancellation_easer_payout_status ?? null,
    cancellation_easer_due_cents: expectedBooking.cancellation_easer_due_cents ?? null,
    assemblecash_redeemed_cents: expectedBooking.assemblecash_redeemed_cents ?? null,
    reschedule_count: expectedBooking.reschedule_count ?? null,
    rescheduled_at: expectedBooking.rescheduled_at ?? null,
    easer_fee_snapshot_easer_id: expectedBooking.easer_fee_snapshot_easer_id ?? null,
    easer_fee_pct_snapshot: expectedBooking.easer_fee_pct_snapshot ?? null,
    easer_estimated_due_snapshot: expectedBooking.easer_estimated_due_snapshot ?? null,
  } : null;
}

export async function reserveBookingFinancialOperation(sb, {
  bookingId,
  operationKey,
  operationType,
  expectedStatuses,
  expectedAssemblerId = null,
  expectedDate = null,
  expectedTime = null,
  checkAppointment = expectedDate != null || expectedTime != null,
  expectedBooking = null,
} = {}) {
  const expectedFinancialSnapshot = buildBookingFinancialSnapshot(expectedBooking);
  const { data, error } = await sb.rpc('reserve_booking_financial_operation', {
    p_booking_id: bookingId,
    p_operation_key: operationKey,
    p_operation_type: operationType,
    p_expected_statuses: expectedStatuses,
    p_expected_assembler_id: expectedAssemblerId,
    p_check_assembler_id: true,
    p_expected_date: expectedDate,
    p_expected_time: expectedTime,
    p_check_appointment: checkAppointment,
    p_expected_financial_snapshot: expectedFinancialSnapshot,
  });

  if (error) {
    const conflict = error.code === '55P03' || /financial operation|state changed|assignee changed|appointment changed/i.test(error.message || '');
    const wrapped = new Error(conflict
      ? 'Another booking or payment action is already in progress. Refresh before trying again.'
      : 'The booking financial lock could not be verified. Apply the required database migration before retrying.');
    wrapped.code = conflict ? 'FINANCIAL_OPERATION_CONFLICT' : 'FINANCIAL_OPERATION_RESERVATION_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }

  return Array.isArray(data) ? data[0] : data;
}

export async function claimBookingCancellationRecovery(sb, {
  booking,
  expectedOperationKey,
  ownerOperationKey,
} = {}) {
  const { data, error } = await sb.rpc('claim_booking_cancellation_recovery', {
    p_booking_id: booking?.id,
    p_expected_operation_key: expectedOperationKey,
    p_owner_operation_key: ownerOperationKey,
    p_expected_status: booking?.status,
    p_expected_assembler_id: booking?.assembler_id ?? null,
    p_expected_date: booking?.date ?? null,
    p_expected_time: booking?.time ?? null,
    p_expected_financial_snapshot: buildBookingFinancialSnapshot(booking),
  });

  if (error) {
    const conflict = error.code === '55P03'
      || /cancellation recovery|state changed|assignee changed|appointment changed|financial state changed/i.test(error.message || '');
    const wrapped = new Error(conflict
      ? 'The customer cancellation is still active or its booking state changed. Refresh before trying owner recovery again.'
      : 'The cancellation recovery lock could not be verified. Apply the required database migration before retrying.');
    wrapped.code = conflict ? 'FINANCIAL_OPERATION_CONFLICT' : 'FINANCIAL_OPERATION_RESERVATION_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }

  return Array.isArray(data) ? data[0] : data;
}

export async function releaseBookingFinancialOperation(sb, { bookingId, operationKey } = {}) {
  const { data, error } = await sb.rpc('release_booking_financial_operation', {
    p_booking_id: bookingId,
    p_operation_key: operationKey,
  });
  if (error) throw error;
  return data === true;
}
