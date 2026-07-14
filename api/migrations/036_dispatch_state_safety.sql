-- ============================================================
-- Migration 036: Dispatch state safety
--
-- Prevent duplicate active offers to the same Easer and provide a
-- row-locked finalization point for resolved dispatch rounds.
-- Apply after migration 035 so assignment snapshots and financial-operation
-- reservation columns exist before the acceptance RPC is replaced.
-- ============================================================

-- Close stale open offers left by older code. Rows remain available for audit;
-- only offers that can no longer be accepted are terminalized.
UPDATE public.dispatch_offers offer
   SET offer_status = 'superseded'
  FROM public.bookings booking
 WHERE offer.booking_id = booking.id
   AND offer.offer_status = 'sent'
   AND (
     booking.status <> 'confirmed'
     OR booking.assembler_id IS NOT NULL
     OR COALESCE(booking.dispatch_paused, FALSE)
     OR COALESCE(booking.needs_manual_dispatch, FALSE)
   );

-- Preserve the newest offer if an older environment created duplicates for an
-- otherwise eligible booking/Easer pair. Earlier rows become terminal history.
WITH ranked_open_offers AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY booking_id, easer_id
           ORDER BY attempt_number DESC, sent_at DESC, created_at DESC, id DESC
         ) AS duplicate_rank
    FROM public.dispatch_offers
   WHERE offer_status = 'sent'
)
UPDATE public.dispatch_offers offer
   SET offer_status = 'superseded'
  FROM ranked_open_offers ranked
 WHERE offer.id = ranked.id
   AND ranked.duplicate_rank > 1;

-- One active offer per booking/Easer pair. Historical terminal offers remain
-- available for audit and exclusion from later rounds.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_offers_active_booking_easer
  ON public.dispatch_offers (booking_id, easer_id)
  WHERE offer_status = 'sent';

-- Atomically decide what happens after an offer is resolved. The booking row
-- lock serializes final-decline/expiry handling with owner assignment and other
-- round finalizers. Only the service role may call this function.
CREATE OR REPLACE FUNCTION public.finalize_dispatch_round(
  p_booking_id UUID,
  p_max_attempts INTEGER,
  p_force_manual BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  result_action TEXT,
  result_ref TEXT,
  result_attempt INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_attempt INTEGER;
BEGIN
  IF p_booking_id IS NULL OR p_max_attempts IS NULL OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'booking id and a positive max attempt count are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::TEXT, NULL::TEXT, 0;
    RETURN;
  END IF;

  v_attempt := COALESCE(v_booking.dispatch_attempt, 0);

  IF v_booking.status <> 'confirmed' OR v_booking.assembler_id IS NOT NULL THEN
    RETURN QUERY SELECT 'stale'::TEXT, v_booking.ref::TEXT, v_attempt;
    RETURN;
  END IF;

  IF v_booking.financial_operation_key IS NOT NULL THEN
    RETURN QUERY SELECT 'financial_operation'::TEXT, v_booking.ref::TEXT, v_attempt;
    RETURN;
  END IF;

  IF COALESCE(v_booking.needs_manual_dispatch, FALSE) THEN
    RETURN QUERY SELECT 'already_manual'::TEXT, v_booking.ref::TEXT, v_attempt;
    RETURN;
  END IF;

  IF COALESCE(v_booking.dispatch_paused, FALSE) THEN
    RETURN QUERY SELECT 'paused'::TEXT, v_booking.ref::TEXT, v_attempt;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.dispatch_offers
     WHERE booking_id = p_booking_id
       AND offer_status = 'sent'
  ) THEN
    RETURN QUERY SELECT 'open_offers'::TEXT, v_booking.ref::TEXT, v_attempt;
    RETURN;
  END IF;

  IF NOT p_force_manual AND v_attempt < p_max_attempts THEN
    RETURN QUERY SELECT 'retry'::TEXT, v_booking.ref::TEXT, v_attempt;
    RETURN;
  END IF;

  UPDATE public.bookings
     SET needs_manual_dispatch = TRUE,
         dispatch_paused = TRUE,
         dispatch_status = 'manual_required'
   WHERE id = p_booking_id
     AND status = 'confirmed'
     AND assembler_id IS NULL
     AND COALESCE(needs_manual_dispatch, FALSE) = FALSE;

  IF FOUND THEN
    INSERT INTO public.activity_logs (
      booking_id,
      event_type,
      actor_type,
      actor_name,
      description,
      metadata
    ) VALUES (
      p_booking_id,
      'dispatch_manual_required',
      'system',
      'dispatch',
      COALESCE(v_booking.ref::TEXT, p_booking_id::TEXT) || ' requires manual dispatch',
      jsonb_build_object('attempt', v_attempt, 'forceManual', p_force_manual)
    );
    RETURN QUERY SELECT 'manual_required'::TEXT, v_booking.ref::TEXT, v_attempt;
  ELSE
    RETURN QUERY SELECT 'stale'::TEXT, v_booking.ref::TEXT, v_attempt;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_dispatch_round(UUID, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_dispatch_round(UUID, INTEGER, BOOLEAN)
  TO service_role;

-- Accept an offer and assign its booking in one database transaction. Locking
-- the offer first serializes accept/decline/expiry; locking the booking second
-- serializes acceptance with cancellation and owner assignment.
DROP FUNCTION IF EXISTS public.accept_dispatch_offer(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.accept_dispatch_offer(UUID, UUID, UUID, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.accept_dispatch_offer(
  p_offer_id UUID,
  p_booking_id UUID,
  p_easer_id UUID,
  p_expected_attempt INTEGER,
  p_easer_name TEXT,
  p_easer_tier TEXT,
  p_easer_fee_pct_snapshot INTEGER,
  p_easer_estimated_due_snapshot INTEGER,
  p_easer_fee_snapshot_at TIMESTAMPTZ,
  p_accepted_at TIMESTAMPTZ
)
RETURNS TABLE (
  result_action TEXT,
  result_ref TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_offer public.dispatch_offers%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
BEGIN
  IF p_offer_id IS NULL
     OR p_booking_id IS NULL
     OR p_easer_id IS NULL
     OR p_expected_attempt IS NULL
     OR p_easer_fee_pct_snapshot IS NULL
     OR p_easer_fee_pct_snapshot NOT IN (25, 30)
     OR p_easer_estimated_due_snapshot IS NULL
     OR p_easer_estimated_due_snapshot < 0
     OR p_easer_fee_snapshot_at IS NULL
     OR p_accepted_at IS NULL THEN
    RAISE EXCEPTION 'offer, booking, Easer, attempt, valid fee snapshot, and acceptance time are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_offer
    FROM public.dispatch_offers
   WHERE id = p_offer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_offer'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_offer.booking_id <> p_booking_id
     OR v_offer.easer_id <> p_easer_id
     OR v_offer.attempt_number <> p_expected_attempt THEN
    RETURN QUERY SELECT 'invalid_offer'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_offer.offer_status <> 'sent' THEN
    RETURN QUERY SELECT 'resolved'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_offer.expires_at <= p_accepted_at THEN
    UPDATE public.dispatch_offers
       SET offer_status = 'expired',
           timed_out_at = p_accepted_at
     WHERE id = p_offer_id
       AND offer_status = 'sent';
    RETURN QUERY SELECT 'expired'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT *
    INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_booking.status <> 'confirmed'
     OR v_booking.assembler_id IS NOT NULL
     OR COALESCE(v_booking.dispatch_attempt, 0) <> p_expected_attempt
     OR COALESCE(v_booking.dispatch_paused, FALSE)
     OR COALESCE(v_booking.needs_manual_dispatch, FALSE)
     OR v_booking.financial_operation_key IS NOT NULL THEN
    RETURN QUERY SELECT 'stale'::TEXT, v_booking.ref::TEXT;
    RETURN;
  END IF;

  UPDATE public.dispatch_offers
     SET offer_status = 'accepted',
         accepted_at = p_accepted_at
   WHERE id = p_offer_id
     AND offer_status = 'sent';

  UPDATE public.bookings
     SET assembler_id = p_easer_id,
         assembler_name = p_easer_name,
         assembler_tier = p_easer_tier,
         assigned_at = p_accepted_at,
         assembler_accepted_at = p_accepted_at,
         dispatch_status = 'accepted',
         dispatch_token = NULL,
         assignment_token = NULL,
         easer_fee_snapshot_easer_id = p_easer_id,
         easer_fee_pct_snapshot = p_easer_fee_pct_snapshot,
         easer_estimated_due_snapshot = p_easer_estimated_due_snapshot,
         easer_fee_snapshot_at = p_easer_fee_snapshot_at
   WHERE id = p_booking_id
     AND status = 'confirmed'
     AND assembler_id IS NULL
     AND COALESCE(dispatch_attempt, 0) = p_expected_attempt
     AND COALESCE(dispatch_paused, FALSE) = FALSE
     AND COALESCE(needs_manual_dispatch, FALSE) = FALSE
     AND financial_operation_key IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking dispatch state changed while accepting offer'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.dispatch_offers
     SET offer_status = 'superseded'
   WHERE booking_id = p_booking_id
     AND id <> p_offer_id
     AND offer_status = 'sent';

  RETURN QUERY SELECT 'accepted'::TEXT, v_booking.ref::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_dispatch_offer(UUID, UUID, UUID, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_dispatch_offer(UUID, UUID, UUID, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;

-- Resolve a decline and make the final-round decision in the same transaction.
-- If this is the last offer in the last attempt, the booking cannot be left
-- confirmed/unassigned without the manual-dispatch flag even if the request
-- process stops immediately after this RPC commits.
CREATE OR REPLACE FUNCTION public.decline_dispatch_offer(
  p_offer_id UUID,
  p_booking_id UUID,
  p_easer_id UUID,
  p_decline_reason TEXT,
  p_declined_at TIMESTAMPTZ,
  p_max_attempts INTEGER
)
RETURNS TABLE (
  result_action TEXT,
  result_ref TEXT,
  result_attempt INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_offer public.dispatch_offers%ROWTYPE;
BEGIN
  IF p_offer_id IS NULL
     OR p_booking_id IS NULL
     OR p_easer_id IS NULL
     OR p_declined_at IS NULL
     OR p_max_attempts IS NULL
     OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'offer, booking, Easer, decline time, and max attempts are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_offer
    FROM public.dispatch_offers
   WHERE id = p_offer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_offer'::TEXT, NULL::TEXT, 0;
    RETURN;
  END IF;

  IF v_offer.booking_id <> p_booking_id
     OR v_offer.easer_id <> p_easer_id THEN
    RETURN QUERY SELECT 'invalid_offer'::TEXT, NULL::TEXT, 0;
    RETURN;
  END IF;

  IF v_offer.offer_status <> 'sent' THEN
    RETURN QUERY SELECT 'resolved'::TEXT, NULL::TEXT, v_offer.attempt_number;
    RETURN;
  END IF;

  IF v_offer.expires_at <= p_declined_at THEN
    RETURN QUERY SELECT 'expired'::TEXT, NULL::TEXT, v_offer.attempt_number;
    RETURN;
  END IF;

  UPDATE public.dispatch_offers
     SET offer_status = 'declined',
         declined_at = p_declined_at,
         decline_reason = COALESCE(NULLIF(LEFT(p_decline_reason, 120), ''), 'no_reason')
   WHERE id = p_offer_id
     AND offer_status = 'sent';

  RETURN QUERY
    SELECT *
      FROM public.finalize_dispatch_round(p_booking_id, p_max_attempts, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.decline_dispatch_offer(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decline_dispatch_offer(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, INTEGER)
  TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (36, 'dispatch_state_safety')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();
