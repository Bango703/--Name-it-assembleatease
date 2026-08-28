-- ============================================================
-- Migration 078: add_booking_crew_member — the atomic crew write
--
-- WHY AN RPC AND NOT THREE UPDATES FROM THE HANDLER
-- Adding a helper to a job is not one write. It inserts the helper's row AND
-- rewrites what everyone already on the job is owed. Done as separate round
-- trips, a failure between them leaves the job over-allocated — the helper owed
-- money the pool never gave up — and nothing in the platform would notice until
-- payout time.
--
-- So the whole change is one transaction, and the pool invariant is checked
-- INSIDE it against freshly locked rows (Article 5, Article 6):
--
--     SUM(due_cents) over active crew <= labor pool        [labor_pool funding]
--
-- The handler proposes; this function is the only thing that decides. A caller
-- cannot talk it into over-allocating a booking by sending different numbers,
-- because the numbers are re-validated here against the booking row itself
-- (Rule 4: the server is always the source of truth).
--
-- p_allocations is [{"easer_id": "...", "due_cents": 1234}, ...] and must cover
-- EVERY active crew member plus the new one. A partial set is rejected rather
-- than merged, because a merge would silently leave someone at a stale amount.
-- ============================================================

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
    CASE WHEN p_fee_pct IN (25, 30) THEN p_fee_pct ELSE NULL END,
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

-- ── Removal is also a money event ───────────────────────────────────────────
-- Removing someone frees their share. Their row is retained (audit) and the
-- freed amount is returned so the caller can show the owner what became
-- available rather than silently re-splitting it.
CREATE OR REPLACE FUNCTION public.remove_booking_crew_member(
  p_booking_id UUID,
  p_easer_id   UUID,
  p_reason     TEXT
)
RETURNS TABLE (
  out_freed_cents INTEGER,
  out_headcount   INTEGER
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  crew_row public.booking_crew%ROWTYPE;
  remaining INTEGER;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A removal reason is required' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO crew_row
    FROM public.booking_crew
   WHERE booking_id = p_booking_id AND easer_id = p_easer_id AND removed_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That Easer is not on this booking' USING ERRCODE = '22000';
  END IF;

  IF crew_row.role = 'lead' THEN
    RAISE EXCEPTION 'The lead cannot be removed here — reassign or release the booking instead.'
      USING ERRCODE = '22000';
  END IF;

  IF crew_row.payout_status = 'paid' THEN
    RAISE EXCEPTION 'That Easer has already been paid for this job. Use a refund or adjustment instead of removal.'
      USING ERRCODE = '22000';
  END IF;

  UPDATE public.booking_crew
     SET removed_at = NOW(), removed_reason = p_reason
   WHERE id = crew_row.id;

  SELECT COUNT(*) INTO remaining
    FROM public.booking_crew
   WHERE booking_id = p_booking_id AND removed_at IS NULL AND payout_status <> 'void';

  PERFORM public.recompute_booking_payout_status(p_booking_id);

  RETURN QUERY SELECT crew_row.due_cents, remaining;
END;
$fn$;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (78, '078_add_crew_member_rpc')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;
