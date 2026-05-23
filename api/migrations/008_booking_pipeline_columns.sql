-- ============================================================
-- Migration 008: Booking Pipeline Columns
-- Run once in Supabase SQL editor (safe to re-run: IF NOT EXISTS)
--
-- These columns are written by easer-status.js (en_route_at,
-- job_started_at, checked_in_at, pipeline_stage), assign.js /
-- accept-dispatch.js (assembler_name, assembler_tier,
-- assembler_accepted_at), and complete.js (assembler_due,
-- payout_status). They were missing from earlier migrations.
-- ============================================================

-- ── Status pipeline timestamp columns ────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS en_route_at       TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at     TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS job_started_at    TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pipeline_stage    TEXT        DEFAULT NULL;

-- ── Assignment metadata ───────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assembler_name        TEXT        DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assembler_tier        TEXT        DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assembler_accepted_at TIMESTAMPTZ DEFAULT NULL;

-- ── Payout columns ────────────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assembler_due   INTEGER DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_status   TEXT    DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_out_at     TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_amount   INTEGER DEFAULT NULL;

-- ── Verification queries ──────────────────────────────────────
-- Run after applying to confirm:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'bookings'
--   AND column_name IN (
--     'en_route_at','checked_in_at','job_started_at','pipeline_stage',
--     'assembler_name','assembler_tier','assembler_accepted_at',
--     'assembler_due','payout_status','paid_out_at','payout_amount'
--   )
-- ORDER BY column_name;
