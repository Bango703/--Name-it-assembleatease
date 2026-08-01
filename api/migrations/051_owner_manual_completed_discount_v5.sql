-- AssembleAtEase migration 051
-- Put the gross-payment ceiling and the completed owner-booking discount path
-- in one authoritative function. This removes the deployment-order dependency
-- between migrations 049 and 050 while preserving Stripe-verified amounts,
-- idempotency, Easer earnings, refund separation, and financial locks.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_owner_manual_payment_event_v5(
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
  v_pi TEXT := NULLIF(BTRIM(COALESCE(p_stripe_payment_intent_id, '')), '');
  v_target_total INTEGER := COALESCE(p_adjusted_total_cents, p_expected_total_cents);
  v_discount INTEGER := COALESCE(p_expected_total_cents, 0) - COALESCE(v_target_total, 0);
  v_subtotal INTEGER;
  v_tax INTEGER;
  v_gross INTEGER;
  v_refunded INTEGER;
  v_fee_total INTEGER;
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  -- A Stripe retry must return the durable ledger result without trying to
  -- apply the discount a second time. Verify the immutable Stripe facts and
  -- the final booking total before treating it as idempotent.
  SELECT * INTO v_existing
    FROM public.owner_manual_payment_events
   WHERE stripe_payment_intent_id = v_pi;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM v_booking.id
       OR v_existing.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_existing.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
       OR v_existing.processing_fee_cents IS DISTINCT FROM p_processing_fee_cents
       OR v_existing.booking_total_after_cents IS DISTINCT FROM v_booking.total_price THEN
      RAISE EXCEPTION 'Stripe PaymentIntent is already recorded with different payment truth'
        USING ERRCODE = '23505';
    END IF;

    SELECT
      COALESCE(SUM(event.amount_cents), 0),
      COALESCE(SUM(event.refunded_cents), 0),
      COALESCE(SUM(event.processing_fee_cents), 0)
      INTO v_gross, v_refunded, v_fee_total
      FROM public.owner_manual_payment_events event
     WHERE event.booking_id = v_booking.id;

    RETURN QUERY SELECT
      'already_recorded'::TEXT,
      v_booking.id,
      v_booking.ref,
      v_booking.total_price,
      GREATEST(0, v_gross - v_refunded),
      GREATEST(0, v_booking.total_price - v_gross),
      v_fee_total,
      (v_gross >= v_booking.total_price);
    RETURN;
  END IF;

  -- All ordinary payments and pre-completion discounts retain the existing v4
  -- implementation. The special branch below exists only for a documented
  -- platform-funded correction to a completed owner-created booking.
  IF v_booking.status <> 'completed' OR v_discount <= 0 THEN
    RETURN QUERY
      SELECT * FROM public.record_owner_manual_payment_event_v4(
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

  -- Assignment and completion do not finalize money. The owner may absorb a
  -- documented discount while the Easer's canonical earnings remain unchanged.
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

  -- Refunds never recreate invoice balance. A discount plus a new payment may
  -- not exceed gross customer money ever collected for the agreed total.
  IF v_refunded > 0 OR v_gross + p_amount_cents > v_target_total THEN
    RAISE EXCEPTION 'Gross recorded customer payments exceed the agreed booking total'
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

  -- The booking now contains the authoritative adjusted total, so v2 records
  -- the already-verified Stripe event without reapplying a discount.
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

REVOKE ALL ON FUNCTION public.record_owner_manual_payment_event_v5(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_payment_event_v5(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (51, 'owner_manual_completed_discount_v5')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
