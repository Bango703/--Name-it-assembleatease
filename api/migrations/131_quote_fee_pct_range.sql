-- ============================================================
-- Migration 131: a custom quote's platform fee may be any whole percent from 10 to 30
--
-- Owner, 2026-11-13 (docs/business-rules/pricing-model-v1.md section 4): the
-- platform's cut on a quote priced from an Easer's offer steps down as the job
-- grows, and card processing is built into the customer's price. The schedule
-- (api/booking/_quote-offers.js steppedQuoteFeePct) picks one whole percent per
-- quote, so the existing percentage-based pay pipeline (computeBookingSplit,
-- the Easer earnings snapshot, dispatch acceptance and crew pay) keeps working
-- and the Easer is still paid at least their price.
--
-- Until now every one of those places allowed only 25 or 30. This widens each
-- to a whole percent from 10 to 30 and changes nothing else:
--   bookings_easer_fee_pct_snapshot_check (035)
--   bookings_quote_offer_snapshot_check   (129)
--   booking_crew fee_pct_snapshot check   (077)
--   accept_dispatch_offer                 (036, one line)
--   add_booking_crew_member               (078, one line)
-- The two functions are copied from their only definitions in this folder
-- with the single check changed. Before running in production, compare them
-- with pg_get_functiondef so no change made outside this folder is lost.
-- If production holds a 25/30 rule under another name, the check at the end
-- stops the whole migration and nothing changes.
-- Rollback: new quotes return to the flat 30% at once with
-- QUOTE_FEE_SCHEDULE=flat; the 25/30 rules can be restored once no stored
-- value outside 25 or 30 remains.
-- ============================================================

BEGIN;

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_easer_fee_pct_snapshot_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_easer_fee_pct_snapshot_check
  CHECK (easer_fee_pct_snapshot IS NULL OR easer_fee_pct_snapshot BETWEEN 10 AND 30);

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_quote_offer_snapshot_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_quote_offer_snapshot_check CHECK (
  selected_quote_offer_id IS NULL OR (
    quote_offer_fee_pct IS NOT NULL AND quote_offer_earnings_cents IS NOT NULL
    AND quote_offer_crew_size IS NOT NULL
    AND quote_offer_fee_pct BETWEEN 10 AND 30 AND quote_offer_earnings_cents > 0
    AND quote_offer_crew_size BETWEEN 1 AND 4
  )
);

ALTER TABLE public.booking_crew DROP CONSTRAINT IF EXISTS booking_crew_fee_pct_snapshot_check;
ALTER TABLE public.booking_crew ADD CONSTRAINT booking_crew_fee_pct_snapshot_check
  CHECK (fee_pct_snapshot IS NULL OR fee_pct_snapshot BETWEEN 10 AND 30);

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
     OR p_easer_fee_pct_snapshot NOT BETWEEN 10 AND 30
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

CREATE OR REPLACE FUNCTION public.add_booking_crew_member(
  p_booking_id   UUID,
  p_easer_id     UUID,
  p_role         TEXT,
  p_funded_from  TEXT,
  p_allocations  JSONB,
  p_pool_cents   INTEGER,
  p_fee_pct      INTEGER DEFAULT NULL,
  p_added_by     TEXT    DEFAULT 'owner',
  p_reason       TEXT    DEFAULT NULL
)
RETURNS TABLE (
  out_crew_id      UUID,
  out_headcount    INTEGER,
  out_total_due    INTEGER,
  out_pool_cents   INTEGER
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  booking_row   public.bookings%ROWTYPE;
  alloc         JSONB;
  alloc_total   INTEGER := 0;
  alloc_count   INTEGER := 0;
  active_count  INTEGER;
  new_crew_id   UUID;
  touched       INTEGER;
BEGIN
  IF p_role NOT IN ('lead', 'helper') THEN
    RAISE EXCEPTION 'role must be lead or helper' USING ERRCODE = '22000';
  END IF;
  IF p_funded_from NOT IN ('labor_pool', 'platform_margin', 'change_order') THEN
    RAISE EXCEPTION 'funded_from must be labor_pool, platform_margin or change_order' USING ERRCODE = '22000';
  END IF;

  -- Lock the booking first, then the crew, so two concurrent adds serialise
  -- rather than both reading the same pool and both spending it.
  SELECT * INTO booking_row FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF booking_row.status IN ('cancelled', 'declined', 'refunded') THEN
    RAISE EXCEPTION 'This booking is %. Nobody can be added to it.', booking_row.status
      USING ERRCODE = '22000';
  END IF;

  IF booking_row.assembler_id IS NULL THEN
    RAISE EXCEPTION 'Assign a lead Easer before adding anyone else to this job.' USING ERRCODE = '22000';
  END IF;

  PERFORM 1 FROM public.booking_crew
   WHERE booking_id = p_booking_id AND removed_at IS NULL
     FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.booking_crew
     WHERE booking_id = p_booking_id AND easer_id = p_easer_id AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'That Easer is already on this booking' USING ERRCODE = '23505';
  END IF;

  -- ── Validate the proposed allocation against the real pool ────────────────
  FOR alloc IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb))
  LOOP
    IF (alloc->>'due_cents')::INTEGER < 0 THEN
      RAISE EXCEPTION 'An allocation cannot be negative' USING ERRCODE = '22000';
    END IF;
    alloc_total := alloc_total + (alloc->>'due_cents')::INTEGER;
    alloc_count := alloc_count + 1;
  END LOOP;

  SELECT COUNT(*) INTO active_count
    FROM public.booking_crew
   WHERE booking_id = p_booking_id AND removed_at IS NULL AND payout_status <> 'void';

  -- Every existing member plus the new one must be named. A partial set would
  -- silently leave somebody on a stale amount.
  IF alloc_count <> active_count + 1 THEN
    RAISE EXCEPTION 'Allocations must cover all % existing crew member(s) plus the new one; got %',
      active_count, alloc_count USING ERRCODE = '22000';
  END IF;

  -- The pool ceiling only binds when the labour pool is what is being divided.
  -- Margin- and change-order-funded additions are new money by definition, and
  -- are constrained by the owner's decision rather than by the pool.
  IF p_funded_from = 'labor_pool' AND alloc_total > COALESCE(p_pool_cents, 0) THEN
    RAISE EXCEPTION 'Allocations total % exceed the labor pool of %. The job cannot pay out more than it collected.',
      alloc_total, COALESCE(p_pool_cents, 0) USING ERRCODE = '22000';
  END IF;

  -- ── Apply ─────────────────────────────────────────────────────────────────
  INSERT INTO public.booking_crew (
    booking_id, easer_id, role, due_cents, fee_pct_snapshot,
    funded_from, payout_status, added_by, added_reason
  ) VALUES (
    p_booking_id, p_easer_id, p_role,
    COALESCE((
      SELECT (a->>'due_cents')::INTEGER
        FROM jsonb_array_elements(p_allocations) a
       WHERE a->>'easer_id' = p_easer_id::text
       LIMIT 1
    ), 0),
    CASE WHEN p_fee_pct BETWEEN 10 AND 30 THEN p_fee_pct ELSE NULL END,
    p_funded_from, 'owed', COALESCE(p_added_by, 'owner'), p_reason
  )
  RETURNING id INTO new_crew_id;

  -- Rewrite what everyone else is owed, in the same transaction. A person whose
  -- payout is already recorded is NOT rewritten: their money is settled, and
  -- silently restating a paid amount would put the ledger and the crew table into
  -- disagreement.
  FOR alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    CONTINUE WHEN (alloc->>'easer_id') = p_easer_id::text;
    UPDATE public.booking_crew
       SET due_cents = (alloc->>'due_cents')::INTEGER
     WHERE booking_id    = p_booking_id
       AND easer_id      = (alloc->>'easer_id')::UUID
       AND removed_at   IS NULL
       AND payout_status = 'owed';
  END LOOP;

  SELECT COUNT(*), COALESCE(SUM(due_cents), 0)
    INTO touched, alloc_total
    FROM public.booking_crew
   WHERE booking_id = p_booking_id AND removed_at IS NULL AND payout_status <> 'void';

  PERFORM public.recompute_booking_payout_status(p_booking_id);

  RETURN QUERY SELECT new_crew_id, touched, alloc_total, COALESCE(p_pool_cents, 0);
END;
$fn$;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN ('public.bookings'::regclass, 'public.booking_crew'::regclass)
      AND pg_get_constraintdef(oid) ~ 'fee_pct(_snapshot)?[^,]*(ANY \(ARRAY\[25, 30\]\)|IN \(25, 30\))'
  ) THEN
    RAISE EXCEPTION 'Migration 131: a 25 or 30 only fee rule is still in place; nothing was changed';
  END IF;
END
$guard$;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (131, 'quote_fee_pct_range')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
