-- ============================================================
-- Migration 021: Stripe Connect tracking columns
-- Purpose: Add optional Stripe Connect account metadata fields so
-- payouts can be tested in Stripe test mode without breaking the
-- existing manual payout flow.
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_connect_onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_details_submitted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_connect_account
  ON profiles (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_destination_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_transfer
  ON bookings (stripe_transfer_id)
  WHERE stripe_transfer_id IS NOT NULL;
