-- ============================================================
-- Migration 077: booking_crew — more than one Easer on a job
--
-- WHY THIS SHAPE
-- bookings.assembler_id is a single UUID referenced 276 times across 63 API
-- files. Widening it to an array would rewrite the platform. It does not need to:
-- assembler_id stays the LEAD — the Easer who accepted, who is dispatched to, who
-- completes the job, whose acceptance rate moves. This table adds everyone else.
--
-- EVERY assigned booking gets a lead row, not just multi-Easer ones. If crew rows
-- existed only for crewed jobs, every reader would need "if crew exists use it,
-- else fall back to assembler_id" — two rules for one fact, which is exactly the
-- drift Article 2 forbids. One rule: the crew table is who is on the job.
--
-- MONEY
-- due_cents is what THIS person earns. funded_from records WHOSE money paid them,
-- because that is the difference between a labor cost and a margin write-off, and
-- the financial dashboard has to be able to tell them apart:
--   labor_pool      — split out of the existing Easer pool. Margin unchanged.
--   platform_margin — the platform absorbed it. Service recovery. Margin drops.
--   change_order    — the customer approved and paid for the extra scope.
--
-- payout_ledger becomes one row PER PERSON per booking. Its UNIQUE(booking_id)
-- index is the reason a second Easer cannot be paid today; it widens to
-- (booking_id, assembler_id). Every existing row already satisfies the new key,
-- because the old index guaranteed at most one row per booking.
-- ============================================================

-- ── 1. The table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_crew (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID        NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  easer_id         UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  role             TEXT        NOT NULL CHECK (role IN ('lead', 'helper')),

  -- What this person earns, and where it came from.
  due_cents        INTEGER     NOT NULL CHECK (due_cents >= 0),
  fee_pct_snapshot INTEGER     CHECK (fee_pct_snapshot IN (25, 30)),
  funded_from      TEXT        NOT NULL
                     CHECK (funded_from IN ('labor_pool', 'platform_margin', 'change_order')),

  -- Payout truth is per person. A booking is only fully paid when every active
  -- crew row is paid — see recompute_booking_payout_status() below.
  payout_status    TEXT        NOT NULL DEFAULT 'owed'
                     CHECK (payout_status IN ('owed', 'paid', 'void')),

  added_by         TEXT        NOT NULL DEFAULT 'owner',
  added_reason     TEXT,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at       TIMESTAMPTZ,
  removed_reason   TEXT
);

-- One person cannot be on the same job twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_crew_unique_person
  ON public.booking_crew (booking_id, easer_id);

-- Exactly one active lead per booking. Partial so a replaced lead stays for audit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_crew_one_active_lead
  ON public.booking_crew (booking_id)
  WHERE role = 'lead' AND removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_booking_crew_booking
  ON public.booking_crew (booking_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_booking_crew_easer
  ON public.booking_crew (easer_id, added_at DESC) WHERE removed_at IS NULL;
-- What the owner still owes, at a glance.
CREATE INDEX IF NOT EXISTS idx_booking_crew_owed
  ON public.booking_crew (booking_id) WHERE payout_status = 'owed' AND removed_at IS NULL;

-- A removed row must say why: a person silently vanishing from a job they worked
-- is how a payout gets lost.
ALTER TABLE public.booking_crew
  DROP CONSTRAINT IF EXISTS booking_crew_removal_coherent_check;
ALTER TABLE public.booking_crew
  ADD CONSTRAINT booking_crew_removal_coherent_check
  CHECK (removed_at IS NULL OR removed_reason IS NOT NULL);

ALTER TABLE public.booking_crew ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'booking_crew' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON public.booking_crew
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END;
$do$;

-- ── 2. Backfill: every currently assigned booking gets its lead row ─────────
-- Without this the table is true for new jobs and silently empty for the ones
-- already in flight, and every consumer would need a fallback path.
INSERT INTO public.booking_crew (
  booking_id, easer_id, role, due_cents, fee_pct_snapshot,
  funded_from, payout_status, added_by, added_reason, added_at
)
SELECT
  b.id,
  b.assembler_id,
  'lead',
  GREATEST(0, COALESCE(b.assembler_due, b.easer_estimated_due_snapshot, 0)),
  CASE WHEN b.easer_fee_pct_snapshot IN (25, 30) THEN b.easer_fee_pct_snapshot ELSE NULL END,
  'labor_pool',
  CASE WHEN b.payout_status = 'paid' THEN 'paid' ELSE 'owed' END,
  'migration_077',
  'Backfilled from bookings.assembler_id so the crew table is authoritative for every assigned job',
  COALESCE(b.updated_at, b.created_at, NOW())
FROM public.bookings b
WHERE b.assembler_id IS NOT NULL
ON CONFLICT (booking_id, easer_id) DO NOTHING;

-- ── 3. payout_ledger: one row per PERSON per booking ────────────────────────
DO $do$
DECLARE
  dupes INTEGER;
BEGIN
  -- Fail loudly rather than drop a uniqueness guarantee on a money table while
  -- duplicates exist.
  SELECT COUNT(*) INTO dupes FROM (
    SELECT booking_id, assembler_id
      FROM public.payout_ledger
     GROUP BY booking_id, assembler_id
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'payout_ledger holds % duplicate (booking_id, assembler_id) pair(s). Resolve before widening the unique key.', dupes;
  END IF;
END;
$do$;

DROP INDEX IF EXISTS idx_payout_ledger_booking_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_ledger_booking_easer_unique
  ON public.payout_ledger (booking_id, assembler_id);

-- ── 4. Booking payout_status becomes DERIVED ────────────────────────────────
-- The column stays: 63 files read it. It is now computed from the crew rather
-- than written independently, so the booking and the crew can never disagree.
-- 'partial' is a NEW value — someone on the job is still owed. Any code that
-- treats "not paid" as "nobody paid" must be updated before this is relied on.
CREATE OR REPLACE FUNCTION public.recompute_booking_payout_status(p_booking_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  total_active INTEGER;
  total_paid   INTEGER;
  next_status  TEXT;
BEGIN
  SELECT COUNT(*) FILTER (WHERE removed_at IS NULL AND payout_status <> 'void'),
         COUNT(*) FILTER (WHERE removed_at IS NULL AND payout_status = 'paid')
    INTO total_active, total_paid
    FROM public.booking_crew
   WHERE booking_id = p_booking_id;

  IF total_active = 0 THEN
    RETURN NULL;                       -- nobody on the job; leave the column alone
  ELSIF total_paid = 0 THEN
    next_status := 'pending';
  ELSIF total_paid < total_active THEN
    next_status := 'partial';          -- someone is still owed
  ELSE
    next_status := 'paid';
  END IF;

  UPDATE public.bookings
     SET payout_status = next_status,
         paid_out_at   = CASE WHEN next_status = 'paid' THEN COALESCE(paid_out_at, NOW()) ELSE NULL END
   WHERE id = p_booking_id;

  RETURN next_status;
END;
$fn$;

-- ── 5. Per-person payout ────────────────────────────────────────────────────
-- Mirrors record_booking_payout, scoped to one crew member. Idempotent by the
-- ledger's unique key (Article 6): a retry raises rather than double-paying.
CREATE OR REPLACE FUNCTION public.record_crew_payout(
  p_booking_id    UUID,
  p_easer_id      UUID,
  p_amount_cents  INTEGER DEFAULT NULL,
  p_notes         TEXT    DEFAULT NULL,
  p_recorded_by   TEXT    DEFAULT 'owner',
  p_payout_method TEXT    DEFAULT 'manual'
)
RETURNS TABLE (
  out_booking_id    UUID,
  out_easer_id      UUID,
  out_payout_amount INTEGER,
  out_booking_state TEXT
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  booking_row  public.bookings%ROWTYPE;
  crew_row     public.booking_crew%ROWTYPE;
  easer_row    public.profiles%ROWTYPE;
  amount_cents INTEGER;
  charged      INTEGER;
  crew_total   INTEGER;
  new_status   TEXT;
BEGIN
  SELECT * INTO booking_row FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF booking_row.status <> 'completed' THEN
    RAISE EXCEPTION 'Only completed bookings can be paid out. Current status: %', booking_row.status
      USING ERRCODE = '22000';
  END IF;

  SELECT * INTO crew_row
    FROM public.booking_crew
   WHERE booking_id = p_booking_id AND easer_id = p_easer_id AND removed_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That Easer is not on this booking' USING ERRCODE = '22000';
  END IF;

  IF crew_row.payout_status = 'paid' THEN
    RAISE EXCEPTION 'Payout already recorded for this Easer on this booking.' USING ERRCODE = '23505';
  END IF;

  amount_cents := COALESCE(p_amount_cents, crew_row.due_cents);
  IF amount_cents IS NULL OR amount_cents <= 0 THEN
    RAISE EXCEPTION 'Cannot determine payout amount for this crew member' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO easer_row FROM public.profiles WHERE id = p_easer_id;
  charged := COALESCE(booking_row.amount_charged, booking_row.total_price::INTEGER, 0);

  SELECT COALESCE(SUM(due_cents), 0) INTO crew_total
    FROM public.booking_crew
   WHERE booking_id = p_booking_id AND removed_at IS NULL;

  INSERT INTO public.payout_ledger (
    booking_id, booking_ref, assembler_id, assembler_name, assembler_tier,
    service, booking_date, amount_charged, assembler_due, payout_amount,
    platform_revenue, payout_notes, recorded_by, payout_method
  ) VALUES (
    booking_row.id, booking_row.ref, p_easer_id,
    COALESCE(easer_row.full_name, 'Easer'), easer_row.tier,
    booking_row.service, booking_row.date::text,
    charged, crew_row.due_cents, amount_cents,
    -- Platform revenue is a booking-level fact, not a per-person one. Attributing
    -- it to the lead only keeps SUM(platform_revenue) per booking correct; a
    -- helper row must never claim it a second time.
    CASE WHEN crew_row.role = 'lead' THEN charged - crew_total ELSE 0 END,
    p_notes, COALESCE(p_recorded_by, 'owner'), COALESCE(p_payout_method, 'manual')
  );

  UPDATE public.booking_crew SET payout_status = 'paid' WHERE id = crew_row.id;

  new_status := public.recompute_booking_payout_status(p_booking_id);

  RETURN QUERY SELECT booking_row.id, p_easer_id, amount_cents, new_status;
END;
$fn$;

-- ── 6. Keep the single-Easer RPC coherent with the crew table ───────────────
-- record_booking_payout still exists and still works. It must also mark the lead
-- crew row paid, or the two disagree the moment it is used. A trigger on the
-- ledger covers BOTH RPCs and any manual insert, so there is one rule.
CREATE OR REPLACE FUNCTION public.sync_lead_crew_payout()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  UPDATE public.booking_crew
     SET payout_status = 'paid'
   WHERE booking_id = NEW.booking_id
     AND easer_id    = NEW.assembler_id
     AND removed_at IS NULL
     AND payout_status <> 'paid';
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_sync_lead_crew_payout ON public.payout_ledger;
CREATE TRIGGER trg_sync_lead_crew_payout
  AFTER INSERT ON public.payout_ledger
  FOR EACH ROW EXECUTE FUNCTION public.sync_lead_crew_payout();

-- ── 7. Record the migration ─────────────────────────────────────────────────
DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (77, '077_booking_crew')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

-- ── Verification ────────────────────────────────────────────────────────────
-- Run these after applying. All three should return ZERO rows.
--
-- 1. Every assigned booking has a lead:
--   SELECT b.id, b.ref FROM bookings b
--    WHERE b.assembler_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM booking_crew c
--                       WHERE c.booking_id = b.id AND c.role = 'lead' AND c.removed_at IS NULL);
--
-- 2. No lead disagrees with bookings.assembler_id:
--   SELECT c.booking_id FROM booking_crew c JOIN bookings b ON b.id = c.booking_id
--    WHERE c.role = 'lead' AND c.removed_at IS NULL AND c.easer_id <> b.assembler_id;
--
-- 3. No crew is owed more than the job collected:
--   SELECT b.ref, SUM(c.due_cents) AS crew_due, b.amount_charged
--     FROM booking_crew c JOIN bookings b ON b.id = c.booking_id
--    WHERE c.removed_at IS NULL AND b.amount_charged IS NOT NULL
--    GROUP BY b.ref, b.amount_charged HAVING SUM(c.due_cents) > b.amount_charged;
