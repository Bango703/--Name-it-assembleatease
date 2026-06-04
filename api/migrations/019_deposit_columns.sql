-- ============================================================
-- Migration 019: Deposit Tracking Columns
-- Run once in Supabase SQL editor (safe to re-run: IF NOT EXISTS)
--
-- These columns are written by api/booking.js when a booking
-- totals $200+ (is_deposit=true) to track that a 25% deposit
-- was collected at booking time, with the balance charged after
-- job completion.
-- ============================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_deposit     BOOLEAN DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_amount INTEGER DEFAULT NULL;

-- ── Verification query ─────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'bookings'
--   AND column_name IN ('is_deposit', 'deposit_amount')
-- ORDER BY column_name;
