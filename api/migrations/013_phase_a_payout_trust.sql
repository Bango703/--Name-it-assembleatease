-- ============================================================
-- Migration 013: Phase A — Manual Payout Trust Stabilization
-- Run in Supabase SQL Editor BEFORE deploying the matching code.
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE throughout.
-- ============================================================


-- ── A. Add payout_method to payout_ledger ────────────────────
-- Records how the owner disbursed funds (e.g. 'zelle', 'venmo',
-- 'check', 'cash', 'manual'). Informational — no enum constraint.

ALTER TABLE payout_ledger ADD COLUMN IF NOT EXISTS payout_method TEXT DEFAULT 'manual';

UPDATE payout_ledger SET payout_method = 'manual' WHERE payout_method IS NULL;


-- ── B. Atomic profile counter increment ──────────────────────
-- Replaces the increment_completed_jobs-only call in
-- assembler-complete.js. Updates both completed_jobs and
-- total_earned in a single UPDATE to prevent lost updates.

CREATE OR REPLACE FUNCTION increment_profile_counters(user_id UUID, earned_cents INTEGER)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE profiles
  SET
    completed_jobs = COALESCE(completed_jobs, 0) + 1,
    total_earned   = COALESCE(total_earned,   0) + earned_cents
  WHERE id = user_id;
$$;

GRANT EXECUTE ON FUNCTION increment_profile_counters(UUID, INTEGER) TO service_role;


-- ── C. Updated record_booking_payout RPC ─────────────────────
-- Adds p_payout_method parameter (default 'manual').
-- Backward-compatible: existing callers without the 5th argument
-- continue to work unchanged.
-- Full replacement of the 010 version via CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION record_booking_payout(
  p_booking_id          UUID,
  p_payout_amount_cents INTEGER,
  p_notes               TEXT    DEFAULT NULL,
  p_recorded_by         TEXT    DEFAULT 'owner',
  p_payout_method       TEXT    DEFAULT 'manual'
)
RETURNS TABLE (
  booking_id       UUID,
  booking_ref      TEXT,
  assembler_id     UUID,
  assembler_name   TEXT,
  assembler_tier   TEXT,
  payout_amount    INTEGER,
  platform_revenue INTEGER,
  amount_charged   INTEGER,
  assembler_due    INTEGER,
  recorded_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  booking_row            bookings%ROWTYPE;
  payout_amount_cents    INTEGER;
  amount_charged_cents   INTEGER;
  assembler_due_cents    INTEGER;
  platform_revenue_cents INTEGER;
BEGIN
  SELECT *
    INTO booking_row
    FROM bookings
   WHERE id = p_booking_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF booking_row.status <> 'completed' THEN
    RAISE EXCEPTION 'Only completed bookings can be paid out. Current status: %', booking_row.status
      USING ERRCODE = '22000';
  END IF;

  IF booking_row.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No assembler assigned to this booking' USING ERRCODE = '22000';
  END IF;

  IF booking_row.payout_status = 'paid' THEN
    RAISE EXCEPTION 'Payout already recorded for this booking.' USING ERRCODE = '23505';
  END IF;

  payout_amount_cents := COALESCE(p_payout_amount_cents, booking_row.assembler_due);
  IF payout_amount_cents IS NULL OR payout_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Cannot determine payout amount — no assembler_due recorded and no amount supplied'
      USING ERRCODE = '22000';
  END IF;

  amount_charged_cents   := COALESCE(booking_row.amount_charged, booking_row.total_price::INTEGER, 0);
  assembler_due_cents    := COALESCE(booking_row.assembler_due, 0);
  platform_revenue_cents := amount_charged_cents - payout_amount_cents;

  UPDATE bookings
     SET payout_amount    = payout_amount_cents,
         paid_out_at      = NOW(),
         payout_notes     = p_notes,
         payout_status    = 'paid',
         platform_revenue = platform_revenue_cents
   WHERE id = booking_row.id;

  INSERT INTO payout_ledger (
    booking_id,
    booking_ref,
    assembler_id,
    assembler_name,
    assembler_tier,
    service,
    booking_date,
    amount_charged,
    assembler_due,
    payout_amount,
    platform_revenue,
    payout_notes,
    recorded_by,
    payout_method
  ) VALUES (
    booking_row.id,
    booking_row.ref,
    booking_row.assembler_id,
    booking_row.assembler_name,
    booking_row.assembler_tier,
    booking_row.service,
    booking_row.date::text,
    amount_charged_cents,
    assembler_due_cents,
    payout_amount_cents,
    platform_revenue_cents,
    p_notes,
    COALESCE(p_recorded_by, 'owner'),
    COALESCE(p_payout_method, 'manual')
  );

  RETURN QUERY
    SELECT
      booking_row.id,
      booking_row.ref,
      booking_row.assembler_id,
      booking_row.assembler_name,
      booking_row.assembler_tier,
      payout_amount_cents,
      platform_revenue_cents,
      amount_charged_cents,
      assembler_due_cents,
      NOW();
END;
$$;


-- ── Verification ─────────────────────────────────────────────
-- Run after applying to confirm all three changes landed.

-- 1. payout_method column exists on payout_ledger
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'payout_ledger'
   AND column_name = 'payout_method';
-- Expected: 1 row

-- 2. Both RPCs exist
SELECT routine_name
  FROM information_schema.routines
 WHERE routine_schema = 'public'
   AND routine_name IN ('increment_profile_counters', 'record_booking_payout')
 ORDER BY routine_name;
-- Expected: 2 rows

-- 3. No payout_ledger rows have NULL payout_method
SELECT COUNT(*)
  FROM payout_ledger
 WHERE payout_method IS NULL;
-- Expected: 0
