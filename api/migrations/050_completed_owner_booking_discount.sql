-- AssembleAtEase migration 050
-- Allow a documented, platform-funded discount on a completed owner booking
-- after an Easer is assigned, while preserving the Easer's agreed earnings and
-- continuing to block finalized payments, payouts, refunds, and active locks.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_owner_manual_payment_event_v3(
  p_booking_id UUID,
  p_operation_key TEXT,
  p_expected_total_cents INTEGER,
  p_adjusted_total_cents INTEGER,
  p_adjustment_note TEXT,
  p_amount_cents INTEGER,
  p_payment_method TEXT,
  p_processing_fee_cents INTEGER,
  p_stripe_payment_intent_id TEXT,
  p_stripe_charge_id TEXT,
  p_stripe_created_at TIMESTAMPTZ,
  p_payment_note TEXT DEFAULT NULL,
  p_recorded_by TEXT DEFAULT 'owner'
)
RETURNS TABLE (
  result_action TEXT,
  booking_id UUID,
  booking_ref TEXT,
  adjusted_total_cents INTEGER,
  amount_collected_cents INTEGER,
  remaining_balance_cents INTEGER,
  processing_fee_total_cents INTEGER,
  payment_collected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.owner_manual_payment_events%ROWTYPE;
  v_result RECORD;
  v_target_total INTEGER;
  v_discount INTEGER;
  v_subtotal INTEGER;
  v_tax INTEGER;
  v_gross INTEGER;
  v_refunded INTEGER;
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  -- Preserve v2 idempotency after the first call rewrites the booking total.
  SELECT * INTO v_existing
    FROM public.owner_manual_payment_events
   WHERE stripe_payment_intent_id = NULLIF(BTRIM(COALESCE(p_stripe_payment_intent_id, '')), '');
  IF FOUND THEN
    RETURN QUERY
      SELECT * FROM public.record_owner_manual_payment_event_v2(
        p_booking_id, p_operation_key, p_expected_total_cents,
        p_adjusted_total_cents, p_adjustment_note, p_amount_cents,
        p_payment_method, p_processing_fee_cents,
        p_stripe_payment_intent_id, p_stripe_charge_id,
        p_stripe_created_at, p_payment_note, p_recorded_by
      );
    RETURN;
  END IF;

  v_target_total := COALESCE(p_adjusted_total_cents, p_expected_total_cents);
  v_discount := COALESCE(p_expected_total_cents, 0) - COALESCE(v_target_total, 0);

  IF v_booking.status <> 'completed' OR v_discount <= 0 THEN
    RETURN QUERY
      SELECT * FROM public.record_owner_manual_payment_event_v2(
        p_booking_id, p_operation_key, p_expected_total_cents,
        p_adjusted_total_cents, p_adjustment_note, p_amount_cents,
        p_payment_method, p_processing_fee_cents,
        p_stripe_payment_intent_id, p_stripe_charge_id,
        p_stripe_created_at, p_payment_note, p_recorded_by
      );
    RETURN;
  END IF;

  IF v_booking.source IS DISTINCT FROM 'owner_manual'
     OR v_booking.payment_status IS DISTINCT FROM 'offline_recorded'
     OR v_booking.total_price IS DISTINCT FROM p_expected_total_cents
     OR v_target_total <= 0
     OR v_target_total >= p_expected_total_cents
     OR COALESCE(BTRIM(p_adjustment_note), '') = '' THEN
    RAISE EXCEPTION 'The completed booking total correction is invalid or stale'
      USING ERRCODE = '23514';
  END IF;

  -- Assignment does not finalize money. The owner may absorb a documented
  -- discount while the Easer's canonical earnings remain unchanged. Payment,
  -- payout, refund, and reconciliation truth still fail closed.
  IF v_booking.payment_collected IS TRUE
     OR COALESCE(v_booking.payout_status, 'unpaid') <> 'unpaid'
     OR COALESCE(v_booking.refund_amount, 0) > 0
     OR v_booking.financial_operation_key IS NOT NULL
     OR v_booking.financial_operation_type IS NOT NULL
     OR v_booking.financial_operation_started_at IS NOT NULL
     OR v_booking.financial_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed booking financials are already finalized or locked'
      USING ERRCODE = '55P03';
  END IF;

  SELECT
    COALESCE(SUM(event.amount_cents), 0),
    COALESCE(SUM(event.refunded_cents), 0)
    INTO v_gross, v_refunded
    FROM public.owner_manual_payment_events event
   WHERE event.booking_id = v_booking.id;

  IF v_refunded > 0 OR v_target_total < (v_gross - v_refunded + p_amount_cents) THEN
    RAISE EXCEPTION 'The corrected total cannot be lower than verified net customer payments'
      USING ERRCODE = '23514';
  END IF;

  v_subtotal := ROUND(v_target_total::NUMERIC / 1.0825)::INTEGER;
  v_tax := v_target_total - v_subtotal;

  UPDATE public.bookings
     SET standard_price_cents = COALESCE(standard_price_cents, v_booking.total_price),
         total_price = v_target_total,
         tax_amount = v_tax,
         price_override_reason = 'goodwill'
   WHERE id = v_booking.id;

  SELECT * INTO v_result
    FROM public.record_owner_manual_payment_event_v2(
      p_booking_id, p_operation_key, v_target_total,
      v_target_total, NULL, p_amount_cents,
      p_payment_method, p_processing_fee_cents,
      p_stripe_payment_intent_id, p_stripe_charge_id,
      p_stripe_created_at, p_payment_note, p_recorded_by
    );

  UPDATE public.owner_manual_payment_events
     SET booking_total_before_cents = p_expected_total_cents,
         booking_total_after_cents = v_target_total,
         discount_cents = v_discount,
         adjustment_note = BTRIM(p_adjustment_note)
   WHERE operation_key = p_operation_key
     AND booking_id = p_booking_id;

  UPDATE public.financial_event_audit
     SET metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
       'originalTotalCents', p_expected_total_cents,
       'adjustedTotalCents', v_target_total,
       'discountCents', v_discount,
       'adjustmentNote', BTRIM(p_adjustment_note),
       'discountFunding', 'platform',
       'easerEarningsPreservedCents', COALESCE(v_booking.assembler_due, 0)
     )
   WHERE idempotency_key = p_operation_key
     AND booking_id = p_booking_id;

  RETURN QUERY SELECT
    v_result.result_action::TEXT,
    v_result.booking_id::UUID,
    v_result.booking_ref::TEXT,
    v_result.adjusted_total_cents::INTEGER,
    v_result.amount_collected_cents::INTEGER,
    v_result.remaining_balance_cents::INTEGER,
    v_result.processing_fee_total_cents::INTEGER,
    v_result.payment_collected::BOOLEAN;
END;
$$;

REVOKE ALL ON FUNCTION public.record_owner_manual_payment_event_v3(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_payment_event_v3(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (50, 'completed_owner_booking_discount')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
