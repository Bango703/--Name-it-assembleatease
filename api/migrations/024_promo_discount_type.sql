-- 024_promo_discount_type.sql
-- Adds discount TYPE (fixed amount vs. percentage) to the owner Marketing promo controls.
-- Builds on 023_marketing_promo_controls.sql (site_marketing_settings, single row id=1).
-- Safe + idempotent: re-running causes no harm. Until this runs, the app falls back to
-- amount-only promos via isMissingColumnError handling in api/_promotions.js + api/owner/promo.js.

-- 1) Discount type: 'amount' (use promo_discount_cents) or 'percent' (use promo_discount_pct).
ALTER TABLE site_marketing_settings
  ADD COLUMN IF NOT EXISTS promo_discount_type TEXT NOT NULL DEFAULT 'amount';

-- 2) Percentage value (0-100), only meaningful when promo_discount_type = 'percent'.
ALTER TABLE site_marketing_settings
  ADD COLUMN IF NOT EXISTS promo_discount_pct INTEGER NOT NULL DEFAULT 0;

-- 3) Guard the type column to the two known values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'site_marketing_settings_promo_discount_type_chk'
  ) THEN
    ALTER TABLE site_marketing_settings
      ADD CONSTRAINT site_marketing_settings_promo_discount_type_chk
      CHECK (promo_discount_type IN ('amount', 'percent'));
  END IF;
END $$;

-- 4) Guard the percentage range to 0-100.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'site_marketing_settings_promo_discount_pct_chk'
  ) THEN
    ALTER TABLE site_marketing_settings
      ADD CONSTRAINT site_marketing_settings_promo_discount_pct_chk
      CHECK (promo_discount_pct >= 0 AND promo_discount_pct <= 100);
  END IF;
END $$;
