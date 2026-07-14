-- ============================================================
-- Migration 035: Completion, earnings, and financial-operation truth
-- Apply after migration 034 and before deploying matching APIs.
-- ============================================================

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS easer_fee_snapshot_easer_id UUID,
  ADD COLUMN IF NOT EXISTS easer_fee_pct_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS easer_estimated_due_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS easer_fee_snapshot_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS financial_operation_type TEXT,
  ADD COLUMN IF NOT EXISTS financial_operation_key TEXT,
  ADD COLUMN IF NOT EXISTS financial_operation_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_balance_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_balance_amount_captured INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_easer_fee_pct_snapshot_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_easer_fee_pct_snapshot_check
      CHECK (easer_fee_pct_snapshot IS NULL OR easer_fee_pct_snapshot IN (25, 30));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_easer_estimated_due_snapshot_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_easer_estimated_due_snapshot_check
      CHECK (easer_estimated_due_snapshot IS NULL OR easer_estimated_due_snapshot >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_stripe_balance_amount_captured_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_stripe_balance_amount_captured_check
      CHECK (stripe_balance_amount_captured IS NULL OR stripe_balance_amount_captured >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_financial_operation_type_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_financial_operation_type_check
      CHECK (
        financial_operation_type IS NULL OR financial_operation_type IN (
          'completion_owner', 'completion_easer',
          'cancel_owner', 'cancel_customer', 'cancel_guest',
          'payout_manual', 'payout_connect'
        )
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_financial_operation_key
  ON public.bookings (financial_operation_key)
  WHERE financial_operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_financial_operation_started
  ON public.bookings (financial_operation_started_at)
  WHERE financial_operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_booking_evidence_completion_truth
  ON public.booking_evidence (booking_id, uploaded_by, created_at DESC)
  WHERE evidence_type = 'completion_photo';

DROP FUNCTION IF EXISTS public.reserve_booking_financial_operation(UUID, TEXT, TEXT, TEXT[], UUID);
DROP FUNCTION IF EXISTS public.reserve_booking_financial_operation(UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.reserve_booking_financial_operation(UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN, TEXT, TEXT, BOOLEAN);

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
    'payout_manual', 'payout_connect'
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
       'amount_charged', v_booking.amount_charged,
       'refund_amount', v_booking.refund_amount,
       'stripe_payment_intent_id', v_booking.stripe_payment_intent_id,
       'stripe_deposit_intent_id', v_booking.stripe_deposit_intent_id,
       'stripe_balance_payment_intent_id', v_booking.stripe_balance_payment_intent_id,
       'payout_status', v_booking.payout_status,
       'cancellation_easer_due_cents', v_booking.cancellation_easer_due_cents
     ) IS DISTINCT FROM p_expected_financial_snapshot THEN
    RAISE EXCEPTION 'Booking financial state changed before financial operation' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type IN ('payout_manual', 'payout_connect')
     AND (
       v_booking.payout_status IS DISTINCT FROM 'pending'
       OR v_booking.stripe_transfer_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Booking payout state changed before payout reservation' USING ERRCODE = '55P03';
  END IF;

  IF v_booking.financial_operation_key IS NULL THEN
    UPDATE public.bookings
       SET financial_operation_key = BTRIM(p_operation_key),
           financial_operation_type = p_operation_type,
           financial_operation_started_at = NOW()
     WHERE id = v_booking.id;
  ELSIF v_booking.financial_operation_key IS DISTINCT FROM BTRIM(p_operation_key)
     OR (
       v_booking.financial_operation_type IS DISTINCT FROM p_operation_type
       AND NOT (
         v_booking.financial_operation_type IN ('completion_owner', 'completion_easer')
         AND p_operation_type IN ('completion_owner', 'completion_easer')
       )
     ) THEN
    RAISE EXCEPTION 'Another financial operation is already in progress: %', v_booking.financial_operation_type USING ERRCODE = '55P03';
  END IF;

  RETURN QUERY SELECT v_booking.id, v_booking.status, v_booking.assembler_id,
    BTRIM(p_operation_key), p_operation_type;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_booking_financial_operation(
  p_booking_id UUID,
  p_operation_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.bookings
     SET financial_operation_key = NULL,
         financial_operation_type = NULL,
         financial_operation_started_at = NULL
   WHERE id = p_booking_id
     AND financial_operation_key = BTRIM(p_operation_key);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_booking_financial_operation(UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN, TEXT, TEXT, BOOLEAN, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_booking_financial_operation(UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN, TEXT, TEXT, BOOLEAN, JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.release_booking_financial_operation(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_booking_financial_operation(UUID, TEXT) TO service_role;

-- Replace the payout recorder so manual and Connect payout paths cannot cross.
DROP FUNCTION IF EXISTS public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.record_booking_payout(
  p_booking_id UUID,
  p_payout_amount_cents INTEGER,
  p_notes TEXT DEFAULT NULL,
  p_recorded_by TEXT DEFAULT 'owner',
  p_payout_method TEXT DEFAULT 'manual'
)
RETURNS TABLE (
  booking_id UUID,
  booking_ref TEXT,
  assembler_id UUID,
  assembler_name TEXT,
  assembler_tier TEXT,
  payout_amount INTEGER,
  platform_revenue INTEGER,
  amount_charged INTEGER,
  assembler_due INTEGER,
  recorded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_row public.bookings%ROWTYPE;
  canonical_due_cents INTEGER;
  amount_charged_cents INTEGER;
  net_captured_cents INTEGER;
  remaining_tax_cents INTEGER;
  stripe_fee_cents INTEGER;
  platform_revenue_cents INTEGER;
  expected_operation_key TEXT;
BEGIN
  SELECT * INTO booking_row FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  expected_operation_key := 'payout:manual:' || booking_row.id::TEXT;
  IF booking_row.financial_operation_type IS DISTINCT FROM 'payout_manual'
     OR booking_row.financial_operation_key IS DISTINCT FROM expected_operation_key THEN
    RAISE EXCEPTION 'Manual payout does not hold the booking payout reservation' USING ERRCODE = '55P03';
  END IF;

  IF booking_row.status = 'completed' THEN
    IF booking_row.payment_status NOT IN ('captured', 'partially_refunded') THEN
      RAISE EXCEPTION 'Customer payment must be captured before payout. Current payment status: %', booking_row.payment_status USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.assembler_due, 0);
    IF booking_row.evidence_requested_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.booking_evidence evidence
       WHERE evidence.booking_id = booking_row.id
         AND evidence.evidence_type = 'completion_photo'
         AND evidence.uploaded_by = booking_row.assembler_id
         AND booking_row.job_started_at IS NOT NULL
         AND evidence.created_at >= booking_row.job_started_at
    ) THEN
      RAISE EXCEPTION 'Valid current-Easer completion evidence is required before payout' USING ERRCODE = '22000';
    END IF;
  ELSIF booking_row.status = 'cancelled' THEN
    IF booking_row.payment_status <> 'cancellation_fee_captured' THEN
      RAISE EXCEPTION 'Cancellation fee must be captured before cancellation earnings can be paid' USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.cancellation_easer_due_cents, 0);
  ELSE
    RAISE EXCEPTION 'Only completed jobs or fee-bearing cancellations can be paid out. Current status: %', booking_row.status USING ERRCODE = '22000';
  END IF;

  IF booking_row.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No Easer assigned to this booking' USING ERRCODE = '22000';
  END IF;
  IF booking_row.payout_status IN ('paid', 'transferred') OR booking_row.stripe_transfer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Payout already recorded or transferred for this booking.' USING ERRCODE = '23505';
  END IF;
  IF canonical_due_cents <= 0 OR p_payout_amount_cents IS DISTINCT FROM canonical_due_cents THEN
    RAISE EXCEPTION 'Payout amount must exactly equal canonical Easer earnings of % cents', canonical_due_cents USING ERRCODE = '22000';
  END IF;
  IF COALESCE(BTRIM(p_notes), '') = '' THEN
    RAISE EXCEPTION 'A bank confirmation ID or payout reference is required' USING ERRCODE = '22000';
  END IF;
  IF LOWER(COALESCE(p_payout_method, 'manual')) = 'stripe_connect' THEN
    RAISE EXCEPTION 'Stripe Connect transfers must be reconciled by Stripe state, not recorded as manual payouts' USING ERRCODE = '22000';
  END IF;

  amount_charged_cents := COALESCE(booking_row.amount_charged, 0);
  net_captured_cents := GREATEST(0, amount_charged_cents - COALESCE(booking_row.refund_amount, 0));
  remaining_tax_cents := CASE
    WHEN booking_row.status = 'cancelled' OR amount_charged_cents <= 0 THEN 0
    ELSE ROUND(COALESCE(booking_row.tax_amount, 0)::NUMERIC * net_captured_cents / amount_charged_cents)::INTEGER
  END;
  stripe_fee_cents := COALESCE(
    booking_row.stripe_fee,
    CASE WHEN net_captured_cents > 0 THEN ROUND(net_captured_cents * 0.029)::INTEGER + 30 ELSE 0 END
  );
  platform_revenue_cents := net_captured_cents - remaining_tax_cents - stripe_fee_cents - canonical_due_cents;

  UPDATE public.bookings SET
    payout_amount = canonical_due_cents,
    paid_out_at = NOW(),
    payout_notes = BTRIM(p_notes),
    payout_status = 'paid',
    platform_revenue = platform_revenue_cents,
    cancellation_easer_payout_status = CASE WHEN booking_row.status = 'cancelled' THEN 'paid' ELSE booking_row.cancellation_easer_payout_status END,
    financial_operation_key = NULL,
    financial_operation_type = NULL,
    financial_operation_started_at = NULL
  WHERE id = booking_row.id;

  INSERT INTO public.payout_ledger (
    booking_id, booking_ref, assembler_id, assembler_name, assembler_tier,
    service, booking_date, amount_charged, assembler_due, payout_amount,
    platform_revenue, payout_notes, recorded_by, payout_method
  ) VALUES (
    booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, booking_row.service,
    booking_row.date::TEXT, amount_charged_cents, canonical_due_cents,
    canonical_due_cents, platform_revenue_cents, BTRIM(p_notes),
    COALESCE(p_recorded_by, 'owner'), LOWER(COALESCE(p_payout_method, 'manual'))
  );

  RETURN QUERY SELECT booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, canonical_due_cents,
    platform_revenue_cents, amount_charged_cents, canonical_due_cents, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (35, 'financial_completion_reservations')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();
