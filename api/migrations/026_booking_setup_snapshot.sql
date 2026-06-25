-- ============================================================
-- Migration 026: Booking snapshot columns for the home-setup model
-- Stores per-booking attribution + rewards/membership context so each booking
-- carries its own canonical pricing snapshot. EXISTING money columns are reused,
-- never duplicated: amount_charged, platform_fee(_pct), assembler_due,
-- service_call_fee, tax_amount, stripe_fee, promo_code, promo_discount_cents.
-- All additive (IF NOT EXISTS) — safe to run anytime, never touches live data.
-- ============================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bundle_slug                 TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assemblecash_earned_cents   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assemblecash_redeemed_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS membership_plan             TEXT;     -- customer Setup Club plan at booking time (NULL if none)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS membership_discount_cents   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pricing_version             TEXT;     -- snapshot version stamp (e.g. 'hs-2026-06')

-- Attach-rate / AOV analytics on which Room-Ready bundle a booking started from.
CREATE INDEX IF NOT EXISTS idx_bookings_bundle_slug
  ON bookings(bundle_slug)
  WHERE bundle_slug IS NOT NULL;
