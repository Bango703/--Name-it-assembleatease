-- ============================================================
-- Migration 020: Service Call Fee Columns
-- Run once in Supabase SQL editor (safe to re-run: IF NOT EXISTS)
--
-- Replaces the old silent minimum-booking adjustment with a
-- transparent Service Call Fee. Zone is determined server-side
-- from the customer's ZIP prefix (787xx=austin_core,
-- Historical zone values included broad ZIP prefixes. Current API code uses a
-- narrower active-ZIP allowlist and must remain the instant-booking authority.
-- ============================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_call_fee INTEGER DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS call_zone         TEXT    DEFAULT NULL;

-- ── Verification query ─────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'bookings'
--   AND column_name IN ('service_call_fee', 'call_zone')
-- ORDER BY column_name;
