-- ============================================================
-- Migration 044: Owner-manual partial payments and return visits
--
-- Owner-created work can span more than one visit and can receive more than
-- one customer payment. A partial payment must never make the whole booking
-- look paid, unlock Easer payout, or masquerade as the website checkout's
-- Stripe authorization.
--
-- This migration:
--   1. creates a constrained owner-manual payment-event ledger;
--   2. adds one row-locked RPC that records a Stripe-verified/manual payment,
--      applies an owner-approved discount safely, and derives the remaining
--      balance;
--   3. keeps the legacy bookings.payment_collected flag false until the ledger
--      equals the exact agreed total; and
--   4. adds current return-visit fields without overwriting the original
--      appointment date or the main booking workflow.
--
-- Apply AFTER migration 043. Safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS return_visit_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS return_visit_date DATE,
  ADD COLUMN IF NOT EXISTS return_visit_time TEXT,
  ADD COLUMN IF NOT EXISTS return_visit_completed_scope TEXT,
  ADD COLUMN IF NOT EXISTS return_visit_remaining_scope TEXT,
  ADD COLUMN IF NOT EXISTS return_visit_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_visit_scheduled_by TEXT,
  ADD COLUMN IF NOT EXISTS return_visit_completed_at TIMESTAMPTZ;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_return_visit_truth_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_return_visit_truth_check
  CHECK (
    return_visit_required IS NOT TRUE
    OR (
      return_visit_date IS NOT NULL
      AND COALESCE(BTRIM(return_visit_completed_scope), '') <> ''
      AND COALESCE(BTRIM(return_visit_remaining_scope), '') <> ''
      AND return_visit_scheduled_at IS NOT NULL
      AND COALESCE(BTRIM(return_visit_scheduled_by), '') <> ''
      AND return_visit_completed_at IS NULL
    )
  );

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payment_method_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_method_check
  CHECK (
    payment_method IS NULL
    OR payment_method IN (
      'stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice', 'mixed'
    )
  );

CREATE TABLE IF NOT EXISTS public.owner_manual_payment_events (
  id                         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id                 UUID        NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  operation_key              TEXT        NOT NULL,
  amount_cents               INTEGER     NOT NULL,
  currency                   TEXT        NOT NULL DEFAULT 'usd',
  payment_method             TEXT        NOT NULL,
  processing_fee_cents       INTEGER     NOT NULL DEFAULT 0,
  stripe_payment_intent_id   TEXT,
  stripe_charge_id           TEXT,
  stripe_created_at          TIMESTAMPTZ,
  booking_total_before_cents INTEGER     NOT NULL,
  booking_total_after_cents  INTEGER     NOT NULL,
  discount_cents             INTEGER     NOT NULL DEFAULT 0,
  adjustment_note            TEXT,
  payment_note               TEXT,
  recorded_by                TEXT        NOT NULL DEFAULT 'owner',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_manual_payment_events_operation_key_unique UNIQUE (operation_key),
  CONSTRAINT owner_manual_payment_events_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT owner_manual_payment_events_currency_usd CHECK (currency = 'usd'),
  CONSTRAINT owner_manual_payment_events_fee_nonnegative CHECK (processing_fee_cents >= 0),
  CONSTRAINT owner_manual_payment_events_totals_positive CHECK (
    booking_total_before_cents > 0
    AND booking_total_after_cents > 0
    AND discount_cents >= 0
    AND booking_total_after_cents = booking_total_before_cents - discount_cents
  ),
  CONSTRAINT owner_manual_payment_events_method_check CHECK (
    payment_method IN ('stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice')
  ),
  CONSTRAINT owner_manual_payment_events_stripe_truth_check CHECK (
    (
      payment_method IN ('stripe_manual', 'card_on_site')
      AND COALESCE(BTRIM(stripe_payment_intent_id), '') <> ''
      AND COALESCE(BTRIM(stripe_charge_id), '') <> ''
      AND stripe_created_at IS NOT NULL
    )
    OR (
      payment_method NOT IN ('stripe_manual', 'card_on_site')
      AND stripe_payment_intent_id IS NULL
      AND stripe_charge_id IS NULL
      AND stripe_created_at IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_manual_payment_events_payment_intent
  ON public.owner_manual_payment_events (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_manual_payment_events_charge
  ON public.owner_manual_payment_events (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_owner_manual_payment_events_booking
  ON public.owner_manual_payment_events (booking_id, created_at);

ALTER TABLE public.owner_manual_payment_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_owner_manual_payment_events
  ON public.owner_manual_payment_events;
CREATE POLICY service_role_all_owner_manual_payment_events
  ON public.owner_manual_payment_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON TABLE public.owner_manual_payment_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.owner_manual_payment_events
  TO service_role;

CREATE OR REPLACE FUNCTION public.guard_owner_manual_payment_aggregate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ledger_total INTEGER;
BEGIN
  IF NEW.source IS DISTINCT FROM 'owner_manual' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(event.amount_cents), 0)
    INTO v_ledger_total
  FROM public.owner_manual_payment_events event
  WHERE event.booking_id = NEW.id;

  IF v_ledger_total > 0 AND NEW.total_price < v_ledger_total THEN
    RAISE EXCEPTION 'Owner-manual booking total cannot be lower than its recorded customer payments'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payment_collected IS TRUE
     AND OLD.payment_collected IS NOT TRUE
     AND v_ledger_total > 0
     AND v_ledger_total IS DISTINCT FROM NEW.total_price THEN
    RAISE EXCEPTION 'Partial customer payments cannot mark an owner-manual booking fully collected'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_guard_owner_manual_payment_aggregate
  ON public.bookings;
CREATE TRIGGER bookings_guard_owner_manual_payment_aggregate
  BEFORE UPDATE OF total_price, payment_collected ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_owner_manual_payment_aggregate();

REVOKE ALL ON FUNCTION public.guard_owner_manual_payment_aggregate()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_owner_manual_payment_event(
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
  v_operation_key TEXT := BTRIM(COALESCE(p_operation_key, ''));
  v_method TEXT := LOWER(BTRIM(COALESCE(p_payment_method, '')));
  v_pi TEXT := NULLIF(BTRIM(COALESCE(p_stripe_payment_intent_id, '')), '');
  v_charge TEXT := NULLIF(BTRIM(COALESCE(p_stripe_charge_id, '')), '');
  v_recorded_by TEXT := BTRIM(COALESCE(NULLIF(p_recorded_by, ''), 'owner'));
  v_target_total INTEGER;
  v_discount INTEGER;
  v_subtotal INTEGER;
  v_tax INTEGER;
  v_collected INTEGER;
  v_fee_total INTEGER;
  v_method_count INTEGER;
  v_single_method TEXT;
  v_latest_collection TIMESTAMPTZ;
  v_fully_collected BOOLEAN;
BEGIN
  IF p_booking_id IS NULL
     OR v_operation_key = ''
     OR CHAR_LENGTH(v_operation_key) > 240
     OR p_expected_total_cents IS NULL
     OR p_expected_total_cents <= 0
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_processing_fee_cents IS NULL
     OR p_processing_fee_cents < 0
     OR v_method NOT IN ('stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice') THEN
    RAISE EXCEPTION 'Invalid owner-manual customer payment record'
      USING ERRCODE = '22023';
  END IF;

  IF v_method IN ('stripe_manual', 'card_on_site') THEN
    IF v_pi IS NULL OR v_charge IS NULL OR p_stripe_created_at IS NULL THEN
      RAISE EXCEPTION 'Stripe payment truth is required for this payment method'
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_pi IS NOT NULL OR v_charge IS NOT NULL OR p_stripe_created_at IS NOT NULL THEN
    RAISE EXCEPTION 'Stripe identifiers cannot be attached to a non-Stripe payment'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_booking
  FROM public.bookings
  WHERE id = p_booking_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_booking.source IS DISTINCT FROM 'owner_manual'
     OR v_booking.payment_status IS DISTINCT FROM 'offline_recorded' THEN
    RAISE EXCEPTION 'Only owner-manual offline bookings can use this payment ledger'
      USING ERRCODE = '23514';
  END IF;
  IF v_booking.status NOT IN ('confirmed', 'en_route', 'arrived', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Customer payment cannot be recorded for booking status %', v_booking.status
      USING ERRCODE = '23514';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL
     OR v_booking.financial_operation_type IS NOT NULL
     OR v_booking.financial_operation_started_at IS NOT NULL
     OR v_booking.financial_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'Resolve the booking financial operation before recording customer money'
      USING ERRCODE = '55P03';
  END IF;

  -- Stripe/web retries must be idempotent even when the first call discounted the
  -- booking total. Compare the immutable event truth before the current-total CAS.
  IF v_pi IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.owner_manual_payment_events
    WHERE stripe_payment_intent_id = v_pi;
    IF FOUND THEN
      IF v_existing.booking_id IS DISTINCT FROM v_booking.id
         OR v_existing.amount_cents IS DISTINCT FROM p_amount_cents
         OR v_existing.stripe_charge_id IS DISTINCT FROM v_charge
         OR v_existing.processing_fee_cents IS DISTINCT FROM p_processing_fee_cents
         OR v_existing.booking_total_before_cents IS DISTINCT FROM p_expected_total_cents
         OR v_existing.booking_total_after_cents IS DISTINCT FROM COALESCE(p_adjusted_total_cents, p_expected_total_cents) THEN
        RAISE EXCEPTION 'Stripe PaymentIntent is already recorded with different payment truth'
          USING ERRCODE = '23505';
      END IF;

      SELECT
        COALESCE(SUM(event.amount_cents), 0),
        COALESCE(SUM(event.processing_fee_cents), 0),
        MAX(event.created_at)
      INTO v_collected, v_fee_total, v_latest_collection
      FROM public.owner_manual_payment_events event
      WHERE event.booking_id = v_booking.id;

      RETURN QUERY SELECT
        'already_recorded'::TEXT,
        v_booking.id,
        v_booking.ref,
        v_booking.total_price,
        v_collected,
        GREATEST(0, v_booking.total_price - v_collected),
        v_fee_total,
        v_booking.payment_collected;
      RETURN;
    END IF;
  END IF;

  IF v_booking.total_price IS DISTINCT FROM p_expected_total_cents THEN
    RAISE EXCEPTION 'Booking total changed before payment reconciliation'
      USING ERRCODE = '40001';
  END IF;

  v_target_total := COALESCE(p_adjusted_total_cents, v_booking.total_price);
  IF v_target_total <= 0 OR v_target_total > v_booking.total_price THEN
    RAISE EXCEPTION 'This payment action may preserve or discount the agreed total, but cannot increase it'
      USING ERRCODE = '23514';
  END IF;

  v_discount := v_booking.total_price - v_target_total;
  IF v_discount > 0 THEN
    IF v_booking.status = 'completed'
       OR v_booking.payment_collected IS TRUE
       OR v_booking.payout_status IN ('paid', 'transferred')
       OR COALESCE(BTRIM(p_adjustment_note), '') = '' THEN
      RAISE EXCEPTION 'A documented discount cannot be applied after financial finalization'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_discount > 0 THEN
    v_subtotal := ROUND(v_target_total::NUMERIC / 1.0825)::INTEGER;
    v_tax := v_target_total - v_subtotal;

    UPDATE public.bookings
       SET standard_price_cents = COALESCE(standard_price_cents, v_booking.total_price),
           total_price = v_target_total,
           tax_amount = v_tax,
           price_override_reason = 'goodwill'
     WHERE id = v_booking.id;
  END IF;

  INSERT INTO public.owner_manual_payment_events (
    booking_id,
    operation_key,
    amount_cents,
    currency,
    payment_method,
    processing_fee_cents,
    stripe_payment_intent_id,
    stripe_charge_id,
    stripe_created_at,
    booking_total_before_cents,
    booking_total_after_cents,
    discount_cents,
    adjustment_note,
    payment_note,
    recorded_by
  ) VALUES (
    v_booking.id,
    v_operation_key,
    p_amount_cents,
    'usd',
    v_method,
    p_processing_fee_cents,
    v_pi,
    v_charge,
    p_stripe_created_at,
    v_booking.total_price,
    v_target_total,
    v_discount,
    NULLIF(BTRIM(COALESCE(p_adjustment_note, '')), ''),
    NULLIF(BTRIM(COALESCE(p_payment_note, '')), ''),
    v_recorded_by
  );

  SELECT
    COALESCE(SUM(event.amount_cents), 0),
    COALESCE(SUM(event.processing_fee_cents), 0),
    COUNT(DISTINCT event.payment_method),
    MIN(event.payment_method),
    MAX(COALESCE(event.stripe_created_at, event.created_at))
  INTO v_collected, v_fee_total, v_method_count, v_single_method, v_latest_collection
  FROM public.owner_manual_payment_events event
  WHERE event.booking_id = v_booking.id;

  IF v_collected > v_target_total THEN
    RAISE EXCEPTION 'Recorded customer payments exceed the agreed booking total'
      USING ERRCODE = '23514';
  END IF;

  v_fully_collected := v_collected = v_target_total;

  UPDATE public.bookings
     SET payment_method = CASE WHEN v_method_count = 1 THEN v_single_method ELSE 'mixed' END,
         stripe_fee = v_fee_total,
         payment_collected = v_fully_collected,
         payment_collected_at = CASE WHEN v_fully_collected THEN v_latest_collection ELSE NULL END,
         payment_collected_by = CASE WHEN v_fully_collected THEN v_recorded_by ELSE NULL END,
         amount_charged = CASE
           WHEN status = 'completed' OR v_fully_collected THEN v_target_total
           ELSE NULL
         END
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
    v_pi,
    'owner_manual_payment_recorded',
    'owner',
    COALESCE(p_stripe_created_at, NOW()),
    'processed',
    v_operation_key,
    jsonb_build_object(
      'amountCents', p_amount_cents,
      'paymentMethod', v_method,
      'processingFeeCents', p_processing_fee_cents,
      'adjustedTotalCents', v_target_total,
      'amountCollectedCents', v_collected,
      'remainingBalanceCents', v_target_total - v_collected,
      'fullyCollected', v_fully_collected,
      'stripeChargeId', v_charge
    )
  );

  RETURN QUERY SELECT
    'recorded'::TEXT,
    v_booking.id,
    v_booking.ref,
    v_target_total,
    v_collected,
    v_target_total - v_collected,
    v_fee_total,
    v_fully_collected;
END;
$$;

REVOKE ALL ON FUNCTION public.record_owner_manual_payment_event(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_payment_event(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (44, 'owner_manual_partial_payments_and_return_visits')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
