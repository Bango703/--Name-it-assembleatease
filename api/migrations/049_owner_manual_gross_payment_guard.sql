-- AssembleAtEase migration 049
-- Keep refunds separate from customer invoice satisfaction. A succeeded refund
-- does not authorize the owner to record replacement customer charges above
-- the original or discounted agreed total.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_owner_manual_payment_event_v4(
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
  v_pi TEXT := NULLIF(BTRIM(COALESCE(p_stripe_payment_intent_id, '')), '');
  v_target_total INTEGER := COALESCE(p_adjusted_total_cents, p_expected_total_cents);
  v_gross INTEGER;
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  -- Preserve idempotent retries before applying the new-payment ceiling.
  SELECT * INTO v_existing
    FROM public.owner_manual_payment_events
   WHERE stripe_payment_intent_id = v_pi;
  IF FOUND THEN
    RETURN QUERY
      SELECT * FROM public.record_owner_manual_payment_event_v3(
        p_booking_id, p_operation_key, p_expected_total_cents,
        p_adjusted_total_cents, p_adjustment_note, p_amount_cents,
        p_payment_method, p_processing_fee_cents,
        p_stripe_payment_intent_id, p_stripe_charge_id,
        p_stripe_created_at, p_payment_note, p_recorded_by
      );
    RETURN;
  END IF;

  SELECT COALESCE(SUM(event.amount_cents), 0)
    INTO v_gross
    FROM public.owner_manual_payment_events event
   WHERE event.booking_id = v_booking.id;

  IF v_target_total IS NULL
     OR v_target_total <= 0
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Invalid agreed total or verified customer payment amount'
      USING ERRCODE = '22023';
  END IF;

  -- Gross payments, not net-of-refunds payments, satisfy the customer invoice.
  -- Refunds remain visible financial adjustments and never recreate balance due.
  IF v_gross + p_amount_cents > v_target_total THEN
    RAISE EXCEPTION 'Gross recorded customer payments exceed the agreed booking total'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
    SELECT * FROM public.record_owner_manual_payment_event_v3(
      p_booking_id, p_operation_key, p_expected_total_cents,
      p_adjusted_total_cents, p_adjustment_note, p_amount_cents,
      p_payment_method, p_processing_fee_cents,
      p_stripe_payment_intent_id, p_stripe_charge_id,
      p_stripe_created_at, p_payment_note, p_recorded_by
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_owner_manual_payment_event_v4(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_payment_event_v4(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (49, 'owner_manual_gross_payment_guard')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
