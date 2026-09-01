-- Keep the database payout reservation aligned with the canonical evidence
-- helper: an owner may supply a completion photo for the assigned Easer
-- without falsely recording the owner as the Easer who uploaded it.
CREATE OR REPLACE FUNCTION public.reserve_booking_financial_operation(
  p_booking_id UUID,
  p_operation_key TEXT,
  p_operation_type TEXT,
  p_expected_statuses TEXT[],
  p_expected_assembler_id UUID DEFAULT NULL,
  p_check_assembler_id BOOLEAN DEFAULT TRUE,
  p_expected_date TEXT DEFAULT NULL,
  p_expected_time TEXT DEFAULT NULL,
  p_check_appointment BOOLEAN DEFAULT FALSE,
  p_expected_financial_snapshot JSONB DEFAULT NULL
)
RETURNS TABLE (
  booking_id UUID,
  booking_status TEXT,
  assembler_id UUID,
  operation_key TEXT,
  operation_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
BEGIN
  IF COALESCE(BTRIM(p_operation_key), '') = '' THEN
    RAISE EXCEPTION 'Financial operation key is required' USING ERRCODE = '22000';
  END IF;
  IF p_operation_type NOT IN (
    'completion_owner', 'completion_easer',
    'cancel_owner', 'cancel_customer', 'cancel_guest',
    'payout_manual', 'payout_connect', 'refund_owner',
    'reauth_payment', 'expire_payment'
  ) THEN
    RAISE EXCEPTION 'Unsupported financial operation type: %', p_operation_type USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_statuses IS NOT NULL
     AND array_length(p_expected_statuses, 1) IS NOT NULL
     AND NOT (v_booking.status = ANY(p_expected_statuses)) THEN
    RAISE EXCEPTION 'Booking state changed before financial operation. Current status: %', v_booking.status USING ERRCODE = '55P03';
  END IF;
  IF p_check_assembler_id
     AND v_booking.assembler_id IS DISTINCT FROM p_expected_assembler_id THEN
    RAISE EXCEPTION 'Booking assignee changed before financial operation' USING ERRCODE = '55P03';
  END IF;
  IF p_check_appointment
     AND (
       v_booking.date::TEXT IS DISTINCT FROM p_expected_date
       OR v_booking.time::TEXT IS DISTINCT FROM p_expected_time
     ) THEN
    RAISE EXCEPTION 'Booking appointment changed before financial operation' USING ERRCODE = '55P03';
  END IF;
  IF p_expected_financial_snapshot IS NOT NULL
     AND jsonb_build_object(
       'payment_status', v_booking.payment_status,
       'total_price', v_booking.total_price,
       'tax_amount', v_booking.tax_amount,
       'service_call_fee', v_booking.service_call_fee,
       'amount_charged', v_booking.amount_charged,
       'refund_amount', v_booking.refund_amount,
       'is_deposit', v_booking.is_deposit,
       'deposit_amount', v_booking.deposit_amount,
       'cancellation_fee', v_booking.cancellation_fee,
       'stripe_customer_id', v_booking.stripe_customer_id,
       'stripe_payment_intent_id', v_booking.stripe_payment_intent_id,
       'stripe_deposit_intent_id', v_booking.stripe_deposit_intent_id,
       'stripe_balance_payment_intent_id', v_booking.stripe_balance_payment_intent_id,
       'stripe_balance_amount_captured', v_booking.stripe_balance_amount_captured,
       'payout_status', v_booking.payout_status,
       'payout_amount', v_booking.payout_amount,
       'payout_mode_snapshot', v_booking.payout_mode_snapshot,
       'payout_review_status', v_booking.payout_review_status,
       'payout_reviewed_at', v_booking.payout_reviewed_at,
       'payout_reviewed_by', v_booking.payout_reviewed_by,
       'payout_review_notes', v_booking.payout_review_notes,
       'evidence_requested_at', v_booking.evidence_requested_at,
       'job_started_at', v_booking.job_started_at,
       'damage_review_status', v_booking.damage_review_status,
       'damage_claim_opened_at', v_booking.damage_claim_opened_at,
       'damage_reviewed_at', v_booking.damage_reviewed_at,
       'damage_reviewed_by', v_booking.damage_reviewed_by,
       'damage_review_notes', v_booking.damage_review_notes,
       'paid_out_at', v_booking.paid_out_at,
       'stripe_transfer_id', v_booking.stripe_transfer_id,
       'assembler_due', v_booking.assembler_due,
       'cancellation_easer_payout_status', v_booking.cancellation_easer_payout_status,
       'cancellation_easer_due_cents', v_booking.cancellation_easer_due_cents,
       'assemblecash_redeemed_cents', v_booking.assemblecash_redeemed_cents,
       'reschedule_count', v_booking.reschedule_count,
       'rescheduled_at', v_booking.rescheduled_at,
       'easer_fee_snapshot_easer_id', v_booking.easer_fee_snapshot_easer_id,
       'easer_fee_pct_snapshot', v_booking.easer_fee_pct_snapshot,
       'easer_estimated_due_snapshot', v_booking.easer_estimated_due_snapshot
     ) IS DISTINCT FROM p_expected_financial_snapshot THEN
    RAISE EXCEPTION 'Booking financial state changed before financial operation' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type IN ('payout_manual', 'payout_connect')
     AND (
       v_booking.payout_status IS DISTINCT FROM 'pending'
       OR v_booking.stripe_transfer_id IS NOT NULL
       OR v_booking.damage_review_status = 'review_required'
       OR v_booking.payout_review_status = 'review_required'
       OR (
         v_booking.damage_review_status = 'resolved'
         AND (
           v_booking.damage_claim_opened_at IS NULL
           OR v_booking.damage_reviewed_at IS NULL
           OR COALESCE(BTRIM(v_booking.damage_reviewed_by), '') = ''
           OR CHAR_LENGTH(BTRIM(COALESCE(v_booking.damage_review_notes, ''))) < 10
         )
       )
       OR (
         v_booking.payout_review_status = 'approved_full'
         AND (
           v_booking.payout_reviewed_at IS NULL
           OR COALESCE(BTRIM(v_booking.payout_reviewed_by), '') = ''
           OR CHAR_LENGTH(BTRIM(COALESCE(v_booking.payout_review_notes, ''))) < 10
         )
       )
       OR (
         v_booking.status = 'completed'
         AND v_booking.evidence_requested_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.booking_evidence evidence
            WHERE evidence.booking_id = v_booking.id
              AND evidence.evidence_type = 'completion_photo'
              AND (
                evidence.uploaded_by = v_booking.assembler_id
                OR evidence.uploaded_on_behalf_of = v_booking.assembler_id
              )
              AND v_booking.job_started_at IS NOT NULL
              AND evidence.created_at >= GREATEST(v_booking.job_started_at, v_booking.evidence_requested_at)
         )
       )
       OR (p_operation_type = 'payout_manual' AND v_booking.payout_mode_snapshot IS DISTINCT FROM 'manual')
       OR (p_operation_type = 'payout_connect' AND v_booking.payout_mode_snapshot IS DISTINCT FROM 'stripe_connect')
     ) THEN
    RAISE EXCEPTION 'Booking payout state changed before payout reservation' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type IN ('cancel_owner', 'cancel_customer', 'cancel_guest')
     AND (
       v_booking.payout_status IN ('paid', 'transferred')
       OR v_booking.cancellation_easer_payout_status IN ('paid', 'transferred')
       OR v_booking.stripe_transfer_id IS NOT NULL
       OR COALESCE(v_booking.payout_amount, 0) > 0
       OR v_booking.paid_out_at IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = v_booking.id)
     ) THEN
    RAISE EXCEPTION 'Booking payout must be reconciled before cancellation' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type = 'reauth_payment'
     AND (
       v_booking.status IS DISTINCT FROM 'confirmed'
       OR v_booking.payment_status IS DISTINCT FROM 'authorized'
       OR v_booking.stripe_payment_intent_id IS NULL
       OR BTRIM(p_operation_key) IS DISTINCT FROM ('reauth:' || v_booking.id::TEXT)
     ) THEN
    RAISE EXCEPTION 'Booking is not eligible for payment reauthorization' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type = 'expire_payment'
     AND (
       v_booking.status IS DISTINCT FROM 'pending'
       OR BTRIM(p_operation_key) IS DISTINCT FROM ('expire:pending:' || v_booking.id::TEXT)
     ) THEN
    RAISE EXCEPTION 'Booking is not eligible for pending-payment expiration' USING ERRCODE = '55P03';
  END IF;

  IF v_booking.financial_reconciliation_required_at IS NOT NULL
     AND v_booking.financial_operation_key IS NULL THEN
    RAISE EXCEPTION 'A malformed financial reconciliation hold blocks new financial operations'
      USING ERRCODE = '55P03';
  END IF;

  IF (v_booking.financial_operation_key IS NULL)
       IS DISTINCT FROM (v_booking.financial_operation_type IS NULL)
     OR (v_booking.financial_operation_key IS NULL)
       IS DISTINCT FROM (v_booking.financial_operation_started_at IS NULL) THEN
    RAISE EXCEPTION 'Booking has a malformed financial operation lock' USING ERRCODE = '55P03';
  ELSIF v_booking.financial_operation_key IS NULL THEN
    UPDATE public.bookings
       SET financial_operation_key = BTRIM(p_operation_key),
           financial_operation_type = p_operation_type,
           financial_operation_started_at = NOW()
     WHERE id = v_booking.id;
  ELSIF v_booking.financial_operation_key IS DISTINCT FROM BTRIM(p_operation_key) THEN
    RAISE EXCEPTION 'Another financial operation is already in progress: %', v_booking.financial_operation_type USING ERRCODE = '55P03';
  ELSIF v_booking.financial_operation_type IS DISTINCT FROM p_operation_type
     AND NOT COALESCE(
       v_booking.financial_operation_type IN ('completion_owner', 'completion_easer')
       AND p_operation_type IN ('completion_owner', 'completion_easer'),
       FALSE
     ) THEN
    RAISE EXCEPTION 'Another financial operation is already in progress: %', v_booking.financial_operation_type USING ERRCODE = '55P03';
  END IF;

  RETURN QUERY SELECT v_booking.id, v_booking.status, v_booking.assembler_id,
    BTRIM(p_operation_key), p_operation_type;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_booking_financial_operation(
  UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN, TEXT, TEXT, BOOLEAN, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_booking_financial_operation(
  UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN, TEXT, TEXT, BOOLEAN, JSONB
) TO service_role;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (92, '092_connect_payout_owner_supplied_evidence')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';