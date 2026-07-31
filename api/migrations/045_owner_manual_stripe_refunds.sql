-- 045_owner_manual_stripe_refunds.sql
-- Adds a server-audited refund ledger for verified owner-manual Stripe payments.
-- Stripe remains the financial source of truth. Booking/customer balances are
-- derived from gross verified payments less succeeded verified refunds.

BEGIN;

ALTER TABLE public.owner_manual_payment_events
  ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latest_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT;

ALTER TABLE public.owner_manual_payment_events
  DROP CONSTRAINT IF EXISTS owner_manual_payment_events_refunded_cents_check;
ALTER TABLE public.owner_manual_payment_events
  ADD CONSTRAINT owner_manual_payment_events_refunded_cents_check
  CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents);

CREATE TABLE IF NOT EXISTS public.owner_manual_refund_events (
  id                               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id                       UUID        NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  payment_event_id                 UUID        NOT NULL REFERENCES public.owner_manual_payment_events(id) ON DELETE RESTRICT,
  operation_key                    TEXT        NOT NULL,
  amount_cents                     INTEGER     NOT NULL,
  cumulative_event_refunded_cents  INTEGER     NOT NULL,
  currency                         TEXT        NOT NULL DEFAULT 'usd',
  stripe_refund_id                 TEXT        NOT NULL,
  stripe_payment_intent_id         TEXT        NOT NULL,
  stripe_charge_id                 TEXT        NOT NULL,
  reason                           TEXT        NOT NULL,
  stripe_created_at                TIMESTAMPTZ,
  refunded_by                      TEXT        NOT NULL DEFAULT 'owner',
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_manual_refund_events_refund_unique UNIQUE (stripe_refund_id),
  CONSTRAINT owner_manual_refund_events_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT owner_manual_refund_events_cumulative_positive CHECK (
    cumulative_event_refunded_cents > 0
  ),
  CONSTRAINT owner_manual_refund_events_currency_usd CHECK (currency = 'usd'),
  CONSTRAINT owner_manual_refund_events_reason_required CHECK (
    LENGTH(BTRIM(reason)) >= 3
  )
);

CREATE INDEX IF NOT EXISTS idx_owner_manual_refund_events_booking
  ON public.owner_manual_refund_events (booking_id, created_at);
CREATE INDEX IF NOT EXISTS idx_owner_manual_refund_events_payment
  ON public.owner_manual_refund_events (payment_event_id, created_at);

ALTER TABLE public.owner_manual_refund_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_owner_manual_refund_events
  ON public.owner_manual_refund_events;
CREATE POLICY service_role_all_owner_manual_refund_events
  ON public.owner_manual_refund_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON TABLE public.owner_manual_refund_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.owner_manual_refund_events
  TO service_role;

-- Enforce the ledger as the source of truth whenever a verified manual-payment
-- ledger exists. This corrects completed manual jobs that previously displayed
-- the full agreed total as charged even when only a partial payment was recorded.
CREATE OR REPLACE FUNCTION public.guard_owner_manual_payment_aggregate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ledger_total INTEGER;
  v_refund_total INTEGER;
  v_net_collected INTEGER;
BEGIN
  IF NEW.source IS DISTINCT FROM 'owner_manual' THEN
    RETURN NEW;
  END IF;

  SELECT
    COALESCE(SUM(event.amount_cents), 0),
    COALESCE(SUM(event.refunded_cents), 0)
    INTO v_ledger_total, v_refund_total
  FROM public.owner_manual_payment_events event
  WHERE event.booking_id = NEW.id;

  v_net_collected := v_ledger_total - v_refund_total;

  IF v_ledger_total > 0 AND NEW.total_price < v_net_collected THEN
    RAISE EXCEPTION 'Owner-manual booking total cannot be lower than its net recorded customer payments'
      USING ERRCODE = '23514';
  END IF;

  IF v_ledger_total > 0 THEN
    NEW.amount_charged := v_ledger_total;
    NEW.refund_amount := v_refund_total;
    NEW.payment_collected := v_net_collected = NEW.total_price;
    IF NEW.payment_collected IS NOT TRUE THEN
      NEW.payment_collected_at := NULL;
      NEW.payment_collected_by := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_guard_owner_manual_payment_aggregate
  ON public.bookings;
CREATE TRIGGER bookings_guard_owner_manual_payment_aggregate
  BEFORE UPDATE OF total_price, payment_collected, amount_charged, refund_amount
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_owner_manual_payment_aggregate();

REVOKE ALL ON FUNCTION public.guard_owner_manual_payment_aggregate()
  FROM PUBLIC, anon, authenticated;

-- Replacement payment recorder that treats succeeded refunds as reductions to
-- net customer funds. This permits a safely verified replacement payment after
-- a refund without ever allowing net collections above the agreed total.
CREATE OR REPLACE FUNCTION public.record_owner_manual_payment_event_v2(
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
  v_gross INTEGER;
  v_refunded INTEGER;
  v_net INTEGER;
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
     OR v_method IS DISTINCT FROM 'stripe_manual'
     OR v_pi IS NULL
     OR v_charge IS NULL
     OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid verified owner-manual Stripe payment record'
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
      COALESCE(SUM(event.refunded_cents), 0),
      COALESCE(SUM(event.processing_fee_cents), 0)
      INTO v_gross, v_refunded, v_fee_total
    FROM public.owner_manual_payment_events event
    WHERE event.booking_id = v_booking.id;
    v_net := v_gross - v_refunded;

    RETURN QUERY SELECT
      'already_recorded'::TEXT,
      v_booking.id,
      v_booking.ref,
      v_booking.total_price,
      v_net,
      GREATEST(0, v_booking.total_price - v_net),
      v_fee_total,
      v_booking.payment_collected;
    RETURN;
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
    COALESCE(SUM(event.refunded_cents), 0),
    COALESCE(SUM(event.processing_fee_cents), 0),
    COUNT(DISTINCT event.payment_method),
    MIN(event.payment_method),
    MAX(COALESCE(event.stripe_created_at, event.created_at))
  INTO v_gross, v_refunded, v_fee_total, v_method_count, v_single_method, v_latest_collection
  FROM public.owner_manual_payment_events event
  WHERE event.booking_id = v_booking.id;

  v_net := v_gross - v_refunded;
  IF v_net > v_target_total THEN
    RAISE EXCEPTION 'Net recorded customer payments exceed the agreed booking total'
      USING ERRCODE = '23514';
  END IF;
  v_fully_collected := v_net = v_target_total;

  UPDATE public.bookings
     SET payment_method = CASE WHEN v_method_count = 1 THEN v_single_method ELSE 'mixed' END,
         stripe_fee = v_fee_total,
         payment_collected = v_fully_collected,
         payment_collected_at = CASE WHEN v_fully_collected THEN v_latest_collection ELSE NULL END,
         payment_collected_by = CASE WHEN v_fully_collected THEN v_recorded_by ELSE NULL END,
         amount_charged = v_gross,
         refund_amount = v_refunded
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
      'grossCollectedCents', v_gross,
      'refundedCents', v_refunded,
      'amountCollectedCents', v_net,
      'remainingBalanceCents', v_target_total - v_net,
      'fullyCollected', v_fully_collected,
      'stripeChargeId', v_charge
    )
  );

  RETURN QUERY SELECT
    'recorded'::TEXT,
    v_booking.id,
    v_booking.ref,
    v_target_total,
    v_net,
    v_target_total - v_net,
    v_fee_total,
    v_fully_collected;
END;
$$;

REVOKE ALL ON FUNCTION public.record_owner_manual_payment_event_v2(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_payment_event_v2(
  UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, INTEGER,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_owner_manual_stripe_refund_event(
  p_booking_id UUID,
  p_payment_event_id UUID,
  p_operation_key TEXT,
  p_expected_event_refunded_cents INTEGER,
  p_refund_amount_cents INTEGER,
  p_stripe_refund_id TEXT,
  p_reason TEXT,
  p_stripe_created_at TIMESTAMPTZ DEFAULT NULL,
  p_refunded_by TEXT DEFAULT 'owner'
)
RETURNS TABLE (
  result_action TEXT,
  booking_id UUID,
  booking_ref TEXT,
  refund_amount_cents INTEGER,
  cumulative_refund_cents INTEGER,
  gross_collected_cents INTEGER,
  net_collected_cents INTEGER,
  remaining_balance_cents INTEGER,
  payment_collected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_payment public.owner_manual_payment_events%ROWTYPE;
  v_existing public.owner_manual_refund_events%ROWTYPE;
  v_operation_key TEXT := BTRIM(COALESCE(p_operation_key, ''));
  v_refund_id TEXT := BTRIM(COALESCE(p_stripe_refund_id, ''));
  v_reason TEXT := BTRIM(COALESCE(p_reason, ''));
  v_refunded_by TEXT := BTRIM(COALESCE(NULLIF(p_refunded_by, ''), 'owner'));
  v_new_event_refunded INTEGER;
  v_gross INTEGER;
  v_refunded INTEGER;
  v_net INTEGER;
  v_fully_collected BOOLEAN;
BEGIN
  IF v_operation_key = '' OR v_refund_id = '' THEN
    RAISE EXCEPTION 'Refund operation key and Stripe refund ID are required'
      USING ERRCODE = '22000';
  END IF;
  IF p_refund_amount_cents IS NULL OR p_refund_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be positive' USING ERRCODE = '22000';
  END IF;
  IF LENGTH(v_reason) < 3 THEN
    RAISE EXCEPTION 'Refund reason must contain at least 3 characters'
      USING ERRCODE = '22000';
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
    RAISE EXCEPTION 'Only verified owner-manual Stripe payments can use this refund ledger'
      USING ERRCODE = '22000';
  END IF;
  IF v_booking.status NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Manual Stripe refunds require a completed or cancelled booking'
      USING ERRCODE = '22000';
  END IF;
  IF v_booking.financial_operation_key IS DISTINCT FROM v_operation_key
     OR v_booking.financial_operation_type IS DISTINCT FROM 'refund_owner' THEN
    RAISE EXCEPTION 'Manual Stripe refund does not own the booking financial lock'
      USING ERRCODE = '55P03';
  END IF;

  SELECT * INTO v_payment
  FROM public.owner_manual_payment_events
  WHERE id = p_payment_event_id
    AND booking_id = v_booking.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verified manual payment event not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_payment.payment_method NOT IN ('stripe_manual', 'card_on_site')
     OR v_payment.stripe_payment_intent_id IS NULL
     OR v_payment.stripe_charge_id IS NULL THEN
    RAISE EXCEPTION 'The selected payment event is not a verified Stripe payment'
      USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_existing
  FROM public.owner_manual_refund_events
  WHERE stripe_refund_id = v_refund_id;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM v_booking.id
       OR v_existing.payment_event_id IS DISTINCT FROM v_payment.id
       OR v_existing.amount_cents IS DISTINCT FROM p_refund_amount_cents THEN
      RAISE EXCEPTION 'Stripe refund is already recorded with different ledger truth'
        USING ERRCODE = '23505';
    END IF;

    SELECT
      COALESCE(SUM(event.amount_cents), 0),
      COALESCE(SUM(event.refunded_cents), 0)
      INTO v_gross, v_refunded
    FROM public.owner_manual_payment_events event
    WHERE event.booking_id = v_booking.id;
    v_net := v_gross - v_refunded;

    RETURN QUERY SELECT
      'already_recorded'::TEXT,
      v_booking.id,
      v_booking.ref,
      p_refund_amount_cents,
      v_refunded,
      v_gross,
      v_net,
      GREATEST(0, v_booking.total_price - v_net),
      v_booking.payment_collected;
    RETURN;
  END IF;

  IF v_payment.refunded_cents IS DISTINCT FROM p_expected_event_refunded_cents THEN
    RAISE EXCEPTION 'Manual payment refund ledger changed before reconciliation'
      USING ERRCODE = '40001';
  END IF;

  v_new_event_refunded := v_payment.refunded_cents + p_refund_amount_cents;
  IF v_new_event_refunded > v_payment.amount_cents THEN
    RAISE EXCEPTION 'Refund exceeds the verified Stripe payment event'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.owner_manual_refund_events (
    booking_id,
    payment_event_id,
    operation_key,
    amount_cents,
    cumulative_event_refunded_cents,
    currency,
    stripe_refund_id,
    stripe_payment_intent_id,
    stripe_charge_id,
    reason,
    stripe_created_at,
    refunded_by
  ) VALUES (
    v_booking.id,
    v_payment.id,
    v_operation_key,
    p_refund_amount_cents,
    v_new_event_refunded,
    'usd',
    v_refund_id,
    v_payment.stripe_payment_intent_id,
    v_payment.stripe_charge_id,
    v_reason,
    p_stripe_created_at,
    v_refunded_by
  );

  UPDATE public.owner_manual_payment_events
     SET refunded_cents = v_new_event_refunded,
         latest_refund_id = v_refund_id,
         refunded_at = COALESCE(p_stripe_created_at, NOW()),
         refund_reason = v_reason
   WHERE id = v_payment.id;

  SELECT
    COALESCE(SUM(event.amount_cents), 0),
    COALESCE(SUM(event.refunded_cents), 0)
    INTO v_gross, v_refunded
  FROM public.owner_manual_payment_events event
  WHERE event.booking_id = v_booking.id;
  v_net := v_gross - v_refunded;
  v_fully_collected := v_net = v_booking.total_price;

  UPDATE public.bookings
     SET amount_charged = v_gross,
         refund_amount = v_refunded,
         refund_id = v_refund_id,
         refunded_at = COALESCE(p_stripe_created_at, NOW()),
         refund_reason = v_reason,
         payment_collected = v_fully_collected,
         payment_collected_at = CASE
           WHEN v_fully_collected THEN payment_collected_at
           ELSE NULL
         END,
         payment_collected_by = CASE
           WHEN v_fully_collected THEN payment_collected_by
           ELSE NULL
         END,
         payout_review_status = CASE
           WHEN status = 'completed'
             AND assembler_id IS NOT NULL
             AND COALESCE(assembler_due, 0) > 0
           THEN 'review_required'
           ELSE payout_review_status
         END,
         payout_reviewed_at = CASE
           WHEN status = 'completed'
             AND assembler_id IS NOT NULL
             AND COALESCE(assembler_due, 0) > 0
           THEN NULL
           ELSE payout_reviewed_at
         END,
         payout_reviewed_by = CASE
           WHEN status = 'completed'
             AND assembler_id IS NOT NULL
             AND COALESCE(assembler_due, 0) > 0
           THEN NULL
           ELSE payout_reviewed_by
         END,
         payout_review_notes = CASE
           WHEN status = 'completed'
             AND assembler_id IS NOT NULL
             AND COALESCE(assembler_due, 0) > 0
           THEN NULL
           ELSE payout_review_notes
         END
   WHERE id = v_booking.id
     AND financial_operation_key = v_operation_key
     AND financial_operation_type = 'refund_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking refund lock changed before ledger reconciliation'
      USING ERRCODE = '55P03';
  END IF;

  RETURN QUERY SELECT
    'recorded'::TEXT,
    v_booking.id,
    v_booking.ref,
    p_refund_amount_cents,
    v_refunded,
    v_gross,
    v_net,
    GREATEST(0, v_booking.total_price - v_net),
    v_fully_collected;
END;
$$;

REVOKE ALL ON FUNCTION public.record_owner_manual_stripe_refund_event(
  UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_stripe_refund_event(
  UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TEXT
) TO service_role;

-- Correct already-recorded ledger bookings without inventing payment truth.
WITH ledger AS (
  SELECT
    booking_id,
    SUM(amount_cents)::INTEGER AS gross_cents,
    SUM(refunded_cents)::INTEGER AS refunded_cents
  FROM public.owner_manual_payment_events
  GROUP BY booking_id
)
UPDATE public.bookings booking
   SET amount_charged = ledger.gross_cents,
       refund_amount = ledger.refunded_cents,
       payment_collected = (ledger.gross_cents - ledger.refunded_cents) = booking.total_price,
       payment_collected_at = CASE
         WHEN (ledger.gross_cents - ledger.refunded_cents) = booking.total_price
         THEN booking.payment_collected_at
         ELSE NULL
       END,
       payment_collected_by = CASE
         WHEN (ledger.gross_cents - ledger.refunded_cents) = booking.total_price
         THEN booking.payment_collected_by
         ELSE NULL
       END
  FROM ledger
 WHERE booking.id = ledger.booking_id
   AND booking.source = 'owner_manual'
   AND booking.payment_status = 'offline_recorded';

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (45, 'owner_manual_stripe_refunds')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
