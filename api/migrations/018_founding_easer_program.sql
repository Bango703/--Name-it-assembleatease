-- ============================================================
-- Migration 018: Founding Easer launch program
-- Purpose: Track whether an application fee was waived for early
-- launch supply-building without losing application status data.
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS application_fee_waived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS founding_easer BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS founding_easer_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_profiles_founding_easer
  ON profiles (founding_easer)
  WHERE founding_easer = true;
