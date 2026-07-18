-- ============================================================
-- Migration 041: Complete the owner-manual Easer payout lane
--
-- A completed owner-entered job may create canonical Easer earnings after the
-- owner links the Easer who performed the work. Because the customer paid
-- outside AssembleAtEase Stripe, payment_status remains offline_recorded.
-- This migration permits an external Easer payout only when the offline
-- customer collection has a complete owner audit record. It never treats that
-- collection as a Stripe capture and does not weaken the online payment path.
--
-- Apply AFTER migrations 039 and 040. Safe to re-run.
-- ============================================================

BEGIN;

DO $$
DECLARE
  required_column TEXT;
BEGIN
  FOREACH required_column IN ARRAY ARRAY[
    'source',
    'payment_collected',
    'payment_collected_at',
    'payment_collected_by'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'bookings'
         AND column_name = required_column
    ) THEN
      RAISE EXCEPTION 'Apply migration 039 before migration 041; missing bookings.%', required_column;
    END IF;
  END LOOP;
END;
$$;

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
  normalized_method TEXT := LOWER(COALESCE(NULLIF(BTRIM(p_payout_method), ''), 'manual'));
  verified_offline_collection BOOLEAN;
  current_payout_status TEXT;
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
  IF booking_row.financial_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'Financial reconciliation must be completed before payout' USING ERRCODE = '22000';
  END IF;
  IF booking_row.payout_mode_snapshot IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'This earning is assigned to the Stripe Connect payout path' USING ERRCODE = '22000';
  END IF;
  IF booking_row.damage_review_status = 'review_required' THEN
    RAISE EXCEPTION 'An open damage review must be resolved before payout' USING ERRCODE = '22000';
  END IF;
  IF booking_row.damage_review_status = 'resolved'
     AND (
       booking_row.damage_claim_opened_at IS NULL
       OR booking_row.damage_reviewed_at IS NULL
       OR COALESCE(BTRIM(booking_row.damage_reviewed_by), '') = ''
       OR CHAR_LENGTH(BTRIM(COALESCE(booking_row.damage_review_notes, ''))) < 10
     ) THEN
    RAISE EXCEPTION 'The damage review record is incomplete' USING ERRCODE = '22000';
  END IF;
  IF booking_row.stripe_dispute_hold IS TRUE
     OR (
       booking_row.stripe_dispute_id IS NOT NULL
       AND LOWER(COALESCE(booking_row.stripe_dispute_status, '')) NOT IN ('won', 'warning_closed', 'prevented')
     ) THEN
    RAISE EXCEPTION 'A Stripe dispute hold must be resolved before payout' USING ERRCODE = '22000';
  END IF;
  IF normalized_method NOT IN ('manual', 'ach', 'zelle', 'paypal', 'check') THEN
    RAISE EXCEPTION 'Unsupported manual payout method: %', normalized_method USING ERRCODE = '22000';
  END IF;

  current_payout_status := CASE
    WHEN booking_row.status = 'cancelled'
      THEN COALESCE(booking_row.cancellation_easer_payout_status, booking_row.payout_status)
    ELSE booking_row.payout_status
  END;
  IF current_payout_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Payout state must be pending before payment can be recorded. Current state: %',
      current_payout_status USING ERRCODE = '22000';
  END IF;

  verified_offline_collection := booking_row.source = 'owner_manual'
    AND booking_row.payment_status = 'offline_recorded'
    AND booking_row.payment_collected IS TRUE
    AND booking_row.payment_collected_at IS NOT NULL
    AND COALESCE(BTRIM(booking_row.payment_collected_by), '') <> ''
    AND LOWER(COALESCE(BTRIM(booking_row.payment_method), '')) IN (
      'stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice'
    )
    AND COALESCE(booking_row.amount_charged, booking_row.total_price, 0) > 0;

  IF booking_row.status = 'completed' THEN
    IF booking_row.payment_status = 'captured' THEN
      NULL;
    ELSIF verified_offline_collection THEN
      -- Narrow owner-manual allowance. This is audited offline collection,
      -- never Stripe capture.
      NULL;
    ELSIF booking_row.payment_status IN ('partially_refunded', 'refunded')
       AND booking_row.payout_review_status = 'approved_full'
       AND booking_row.payout_reviewed_at IS NOT NULL
       AND COALESCE(BTRIM(booking_row.payout_reviewed_by), '') <> ''
       AND CHAR_LENGTH(BTRIM(COALESCE(booking_row.payout_review_notes, ''))) >= 10 THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Customer funds and payout review must be complete before payout. Payment: %, review: %',
        booking_row.payment_status, booking_row.payout_review_status USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.assembler_due, 0);
    IF booking_row.evidence_requested_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.booking_evidence evidence
       WHERE evidence.booking_id = booking_row.id
         AND evidence.evidence_type = 'completion_photo'
         AND evidence.uploaded_by = booking_row.assembler_id
         AND booking_row.job_started_at IS NOT NULL
         AND evidence.created_at >= GREATEST(booking_row.job_started_at, booking_row.evidence_requested_at)
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

  amount_charged_cents := COALESCE(booking_row.amount_charged, booking_row.total_price, 0);
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
    COALESCE(p_recorded_by, 'owner'), normalized_method
  );

  RETURN QUERY SELECT booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, canonical_due_cents,
    platform_revenue_cents, amount_charged_cents, canonical_due_cents, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT)
  TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (41, 'owner_manual_collected_payout')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
