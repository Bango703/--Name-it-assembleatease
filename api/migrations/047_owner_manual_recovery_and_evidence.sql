-- 047_owner_manual_recovery_and_evidence.sql
-- Closes three owner-manual recovery gaps:
--   1. A booking cannot be completed while a return visit remains open.
--   2. A documented downward total correction can be recorded atomically with
--      a verified Stripe payment on a completed but financially unsettled job.
--   3. The owner can preserve historical completion evidence after linking the
--      completed job to the singular owner-Easer account.

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_booking_return_visit_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF COALESCE(NEW.return_visit_required, FALSE) THEN
    IF NEW.return_visit_date IS NULL
       OR NULLIF(BTRIM(COALESCE(NEW.return_visit_time, '')), '') IS NULL
       OR CHAR_LENGTH(BTRIM(COALESCE(NEW.return_visit_remaining_scope, ''))) < 5 THEN
      RAISE EXCEPTION 'An open return visit requires its date, time, and remaining work'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'completed' THEN
      RAISE EXCEPTION 'A booking cannot be completed while a return visit remains open'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.return_visit_completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'An open return visit cannot already have a completion timestamp'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_guard_return_visit_completion
  ON public.bookings;
CREATE TRIGGER bookings_guard_return_visit_completion
  BEFORE INSERT OR UPDATE OF status, return_visit_required, return_visit_date,
    return_visit_time, return_visit_remaining_scope, return_visit_completed_at
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_booking_return_visit_completion();

REVOKE ALL ON FUNCTION public.guard_booking_return_visit_completion()
  FROM PUBLIC, anon, authenticated;

-- Wrapper around migration 045's verified Stripe recorder. For active jobs it
-- preserves the existing v2 behavior. For a completed owner-manual job it may
-- apply a downward correction only while customer money, refunds, and Easer
-- payout remain unsettled. The total correction and Stripe ledger insert share
-- one database transaction, so neither can commit alone.
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
  IF v_booking.payment_collected IS TRUE
     OR v_booking.assembler_id IS NOT NULL
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
       'adjustmentNote', BTRIM(p_adjustment_note)
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

CREATE OR REPLACE FUNCTION public.record_owner_manual_completion_evidence(
  p_booking_id UUID,
  p_uploaded_by UUID,
  p_storage_path TEXT,
  p_mime_type TEXT,
  p_file_size_bytes INTEGER,
  p_notes TEXT
)
RETURNS TABLE (
  evidence_id UUID,
  evidence_type TEXT,
  mime_type TEXT,
  file_size_bytes INTEGER,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_existing public.booking_evidence%ROWTYPE;
  v_evidence public.booking_evidence%ROWTYPE;
  v_count INTEGER;
  v_notes TEXT := NULLIF(BTRIM(COALESCE(p_notes, '')), '');
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
    FROM public.booking_evidence evidence
   WHERE evidence.storage_path = p_storage_path;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.uploaded_by IS DISTINCT FROM p_uploaded_by
       OR v_existing.evidence_type IS DISTINCT FROM 'completion_photo' THEN
      RAISE EXCEPTION 'Evidence path is already linked to different evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.evidence_type,
      v_existing.mime_type, v_existing.file_size_bytes, v_existing.created_at;
    RETURN;
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = p_uploaded_by
     AND role = 'assembler'
     AND is_owner IS TRUE;
  IF NOT FOUND
     OR v_booking.source IS DISTINCT FROM 'owner_manual'
     OR v_booking.payment_status IS DISTINCT FROM 'offline_recorded'
     OR v_booking.status IS DISTINCT FROM 'completed'
     OR v_booking.assembler_id IS DISTINCT FROM p_uploaded_by THEN
    RAISE EXCEPTION 'Historical evidence requires a completed owner booking linked to the owner-Easer'
      USING ERRCODE = '42501';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL
     OR v_booking.financial_operation_type IS NOT NULL
     OR v_booking.financial_operation_started_at IS NOT NULL
     OR v_booking.financial_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'A financial operation is active; evidence cannot be uploaded now'
      USING ERRCODE = '55P03';
  END IF;
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
     OR p_file_size_bytes IS NULL
     OR p_file_size_bytes <= 0
     OR p_file_size_bytes > 5242880
     OR CHAR_LENGTH(COALESCE(v_notes, '')) < 10
     OR CHAR_LENGTH(COALESCE(v_notes, '')) > 2000
     OR COALESCE(BTRIM(p_storage_path), '') = ''
     OR p_storage_path NOT LIKE ('evidence/' || v_booking.id::TEXT || '/%') THEN
    RAISE EXCEPTION 'Historical evidence file or notes are invalid'
      USING ERRCODE = '22000';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.booking_evidence evidence
   WHERE evidence.booking_id = v_booking.id;
  IF v_count >= 5 THEN
    RAISE EXCEPTION 'Maximum 5 evidence files per booking'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.booking_evidence (
    booking_id, uploaded_by, storage_path, evidence_type, mime_type,
    file_size_bytes, visibility, notes
  ) VALUES (
    v_booking.id, p_uploaded_by, BTRIM(p_storage_path), 'completion_photo',
    p_mime_type, p_file_size_bytes, 'owner', v_notes
  ) RETURNING * INTO v_evidence;

  RETURN QUERY SELECT v_evidence.id, v_evidence.evidence_type,
    v_evidence.mime_type, v_evidence.file_size_bytes, v_evidence.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_owner_manual_completion_evidence(
  UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_completion_evidence(
  UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (47, 'owner_manual_recovery_and_evidence')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
