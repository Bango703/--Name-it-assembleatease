-- ============================================================
-- Migration 002: P0 Hardening
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- All statements are safe to re-run (IF NOT EXISTS / CREATE OR REPLACE)
-- ============================================================


-- ── SECTION A: Verify dispatch_offers migration ran ──────────
-- If this SELECT returns 0, run 001_dispatch_offers.sql first.
-- SELECT COUNT(*) FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'dispatch_offers';


-- ── SECTION B: atomic completed_jobs increment ───────────────
-- Required by complete.js and assembler-complete.js.
-- Without this, the code falls back to non-atomic read-modify-write.
CREATE OR REPLACE FUNCTION increment_completed_jobs(user_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE profiles
  SET completed_jobs = COALESCE(completed_jobs, 0) + 1
  WHERE id = user_id;
$$;

-- Grant execution to the service role used by API functions
GRANT EXECUTE ON FUNCTION increment_completed_jobs(UUID) TO service_role;


-- ── SECTION C: bookings — guard columns ──────────────────────
-- Ensure the columns that the .neq() guards reference exist.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_charged     INTEGER  DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee_pct   INTEGER  DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee       INTEGER  DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_captured_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_by       TEXT     DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at       TIMESTAMPTZ DEFAULT NULL;


-- ── SECTION D: dispatch scoring fields ───────────────────────
-- These power active_jobs_today overload penalty and acceptance_rate scoring.
-- Already in 001 but included here for safety.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS acceptance_rate           NUMERIC(5,2) DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS active_jobs_today         INTEGER      DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_dispatch_declined_at TIMESTAMPTZ  DEFAULT NULL;


-- ── SECTION E: bookings dispatch control columns ─────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispatch_attempt      INTEGER  DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS needs_manual_dispatch  BOOLEAN  DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispatch_paused        BOOLEAN  DEFAULT false;


-- ── SECTION F: dispatch_offers table ─────────────────────────
CREATE TABLE IF NOT EXISTS dispatch_offers (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id        UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  easer_id          UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dispatch_score    INTEGER     NOT NULL DEFAULT 0,
  offer_status      TEXT        NOT NULL DEFAULT 'sent',
  token             TEXT        NOT NULL,
  attempt_number    INTEGER     NOT NULL DEFAULT 1,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  accepted_at       TIMESTAMPTZ,
  declined_at       TIMESTAMPTZ,
  timed_out_at      TIMESTAMPTZ,
  decline_reason    TEXT,
  notification_sent BOOLEAN     DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(token)
);

CREATE INDEX IF NOT EXISTS idx_do_booking ON dispatch_offers(booking_id);
CREATE INDEX IF NOT EXISTS idx_do_easer   ON dispatch_offers(easer_id);
CREATE INDEX IF NOT EXISTS idx_do_token   ON dispatch_offers(token);
CREATE INDEX IF NOT EXISTS idx_do_expires ON dispatch_offers(expires_at) WHERE offer_status = 'sent';
CREATE INDEX IF NOT EXISTS idx_do_status  ON dispatch_offers(offer_status);

-- RLS
ALTER TABLE dispatch_offers ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'dispatch_offers' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON dispatch_offers
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;


-- ── SECTION G: high-traffic query indexes ────────────────────
-- Speeds up the dispatch eligibility query on profiles
CREATE INDEX IF NOT EXISTS idx_profiles_dispatch_eligible
  ON profiles(role, status, identity_verified, tier)
  WHERE role = 'assembler' AND status = 'active';

-- Speeds up booking list query
CREATE INDEX IF NOT EXISTS idx_bookings_status
  ON bookings(status);

CREATE INDEX IF NOT EXISTS idx_bookings_assembler
  ON bookings(assembler_id) WHERE assembler_id IS NOT NULL;


-- ── SECTION H: verification queries ──────────────────────────
-- Run these after applying the migration to confirm everything exists.
-- Expected: all 3 return at least 1 row.

-- 1. Check dispatch_offers table:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'dispatch_offers';

-- 2. Check increment_completed_jobs function:
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public' AND routine_name = 'increment_completed_jobs';

-- 3. Check scoring columns on profiles:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'profiles'
--   AND column_name IN ('acceptance_rate', 'active_jobs_today', 'last_dispatch_declined_at');
