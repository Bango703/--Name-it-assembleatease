-- Migration 052: close a completed owner-manual invoice when the only
-- remaining balance is an owner-approved customer discount.
--
-- This action does not create, capture, refund, or transfer money. Verified
-- owner_manual_payment_events remain the payment source of truth. The RPC only
-- lowers the agreed invoice total to the already-recorded gross payments,
-- recalculates collected sales tax, preserves Easer earnings, and writes an
-- immutable financial audit event.

BEGIN;

CREATE OR REPLACE FUNCTION public.close_owner_manual_balance_as_discount_v1(
  p_booking_id UUID,
  p_operation_key TEXT,
  p_expected_total_cents INTEGER,
  p_expected_discount_cents INTEGER,
  p_adjustment_note TEXT,
  p_recorded_by TEXT DEFAULT 'owner'
)
RETURNS TABLE (
  result_action TEXT,
  booking_id UUID,
  booking_ref TEXT,
  original_total_cents INTEGER,
  adjusted_total_cents INTEGER,
  discount_cents INTEGER,
  gross_collected_cents INTEGER,
  processing_fee_total_cents INTEGER,
  tax_collected_cents INTEGER,
  easer_earnings_cents INTEGER,
  platform_gross_cents INTEGER,
  payment_collected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.financial_event_audit%ROWTYPE;
  v_operation_key TEXT := BTRIM(COALESCE(p_operation_key, ''));
  v_note TEXT := BTRIM(COALESCE(p_adjustment_note, ''));
  v_recorded_by TEXT := BTRIM(COALESCE(NULLIF(p_recorded_by, ''), 'owner'));
  v_gross INTEGER := 0;
  v_refunded INTEGER := 0;
  v_fee_total INTEGER := 0;
  v_method_count INTEGER := 0;
  v_single_method TEXT;
  v_latest_collection TIMESTAMPTZ;
  v_target_total INTEGER := 0;
  v_discount INTEGER := 0;
  v_subtotal INTEGER := 0;
  v_tax INTEGER := 0;
  v_easer_due INTEGER := 0;
  v_platform_gross INTEGER := 0;
BEGIN
  IF p_booking_id IS NULL
     OR v_operation_key = ''
     OR CHAR_LENGTH(v_operation_key) > 240
     OR p_expected_total_cents IS NULL
     OR p_expected_total_cents <= 0
     OR p_expected_discount_cents IS NULL
     OR p_expected_discount_cents <= 0
     OR CHAR_LENGTH(v_note) < 10
     OR CHAR_LENGTH(v_note) > 500 THEN
    RAISE EXCEPTION 'Invalid owner-manual balance discount request'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  -- A network retry must return the already-committed result without changing
  -- the invoice a second time.
  SELECT * INTO v_existing
    FROM public.financial_event_audit
   WHERE booking_id = p_booking_id
     AND idempotency_key = v_operation_key
     AND event_type = 'owner_manual_balance_discounted'
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT
      'already_applied'::TEXT,
      v_booking.id,
      v_booking.ref,
      COALESCE((v_existing.metadata->>'originalTotalCents')::INTEGER, p_expected_total_cents),
      COALESCE((v_existing.metadata->>'adjustedTotalCents')::INTEGER, v_booking.total_price),
      COALESCE((v_existing.metadata->>'discountCents')::INTEGER, p_expected_discount_cents),
      COALESCE((v_existing.metadata->>'grossCollectedCents')::INTEGER, v_booking.amount_charged),
      COALESCE((v_existing.metadata->>'processingFeeCents')::INTEGER, v_booking.stripe_fee, 0),
      COALESCE((v_existing.metadata->>'taxCollectedCents')::INTEGER, v_booking.tax_amount, 0),
      COALESCE((v_existing.metadata->>'easerEarningsPreservedCents')::INTEGER, v_booking.assembler_due, 0),
      COALESCE((v_existing.metadata->>'platformGrossCents')::INTEGER, v_booking.platform_revenue, 0),
      v_booking.payment_collected;
    RETURN;
  END IF;

  IF v_booking.source IS DISTINCT FROM 'owner_manual'
     OR v_booking.payment_status IS DISTINCT FROM 'offline_recorded'
     OR v_booking.status IS DISTINCT FROM 'completed'
     OR v_booking.total_price IS DISTINCT FROM p_expected_total_cents THEN
    RAISE EXCEPTION 'Completed owner-manual booking total changed or is ineligible'
      USING ERRCODE = '40001';
  END IF;

  IF v_booking.payment_collected IS TRUE
     OR COALESCE(v_booking.payout_status, 'unpaid') IN ('paid', 'transferred')
     OR v_booking.stripe_transfer_id IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.payout_ledger ledger
        WHERE ledger.booking_id = v_booking.id
     )
     OR v_booking.financial_operation_key IS NOT NULL
     OR v_booking.financial_operation_type IS NOT NULL
     OR v_booking.financial_operation_started_at IS NOT NULL
     OR v_booking.financial_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed booking financials are already finalized or locked'
      USING ERRCODE = '55P03';
  END IF;

  SELECT
    COALESCE(SUM(event.amount_cents), 0),
    COALESCE(SUM(event.refunded_cents), 0),
    COALESCE(SUM(event.processing_fee_cents), 0),
    COUNT(DISTINCT event.payment_method),
    MIN(event.payment_method),
    MAX(COALESCE(event.stripe_created_at, event.created_at))
    INTO v_gross, v_refunded, v_fee_total,
         v_method_count, v_single_method, v_latest_collection
    FROM public.owner_manual_payment_events event
   WHERE event.booking_id = v_booking.id;

  IF v_refunded > 0 THEN
    RAISE EXCEPTION 'Refund-affected invoices require refund reconciliation, not a balance discount'
      USING ERRCODE = '23514';
  END IF;

  v_target_total := v_gross;
  v_discount := v_booking.total_price - v_target_total;
  IF v_target_total <= 0
     OR v_target_total >= v_booking.total_price
     OR v_discount IS DISTINCT FROM p_expected_discount_cents THEN
    RAISE EXCEPTION 'Recorded payments and the confirmed discount no longer match the invoice balance'
      USING ERRCODE = '40001';
  END IF;

  v_tax := CASE
    WHEN COALESCE(v_booking.tax_amount, 0) > 0
      THEN v_target_total - ROUND(v_target_total::NUMERIC / 1.0825)::INTEGER
    ELSE 0
  END;
  v_subtotal := v_target_total - v_tax;
  v_easer_due := GREATEST(COALESCE(v_booking.assembler_due, 0), 0);
  v_platform_gross := v_target_total - v_tax - v_fee_total - v_easer_due;

  UPDATE public.bookings
     SET standard_price_cents = COALESCE(standard_price_cents, v_booking.total_price),
         total_price = v_target_total,
         tax_amount = v_tax,
         price_override_reason = 'goodwill',
         payment_method = CASE WHEN v_method_count = 1 THEN v_single_method ELSE 'mixed' END,
         stripe_fee = v_fee_total,
         payment_collected = TRUE,
         payment_collected_at = COALESCE(v_latest_collection, NOW()),
         payment_collected_by = v_recorded_by,
         amount_charged = v_gross,
         refund_amount = 0
   WHERE id = v_booking.id;

  INSERT INTO public.financial_event_audit (
    booking_id,
    payment_intent_id,
    event_type,
    event_source,
    event_created_at,
    status,
    idempotency_key,
    metadata
  ) VALUES (
    v_booking.id,
    NULL,
    'owner_manual_balance_discounted',
    'owner',
    NOW(),
    'processed',
    v_operation_key,
    jsonb_build_object(
      'originalTotalCents', v_booking.total_price,
      'adjustedTotalCents', v_target_total,
      'discountCents', v_discount,
      'adjustmentNote', v_note,
      'discountFunding', 'platform',
      'grossCollectedCents', v_gross,
      'processingFeeCents', v_fee_total,
      'taxCollectedCents', v_tax,
      'taxableSubtotalCents', v_subtotal,
      'easerEarningsPreservedCents', v_easer_due,
      'platformGrossCents', v_platform_gross,
      'noCustomerChargeCreated', TRUE,
      'noRefundCreated', TRUE,
      'noPayoutCreated', TRUE
    )
  );

  RETURN QUERY SELECT
    'discount_applied'::TEXT,
    v_booking.id,
    v_booking.ref,
    v_booking.total_price,
    v_target_total,
    v_discount,
    v_gross,
    v_fee_total,
    v_tax,
    v_easer_due,
    v_platform_gross,
    TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.close_owner_manual_balance_as_discount_v1(
  UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_owner_manual_balance_as_discount_v1(
  UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (52, 'owner_manual_balance_discount_close')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
