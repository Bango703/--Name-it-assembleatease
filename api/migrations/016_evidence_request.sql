-- ============================================================
-- Migration 016: Evidence request tracking on bookings
-- Purpose: Allow owner to request completion evidence from an
-- Easer and hold payout until evidence is received.
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS evidence_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bookings_evidence_requested
  ON bookings (evidence_requested_at)
  WHERE evidence_requested_at IS NOT NULL;
