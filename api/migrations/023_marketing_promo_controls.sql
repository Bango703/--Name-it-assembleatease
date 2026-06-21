-- ============================================================
-- Migration 023: Owner-managed promo controls + booking promo
-- tracking
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS site_marketing_settings (
  id                   INTEGER     PRIMARY KEY CHECK (id = 1),
  promo_enabled        BOOLEAN     NOT NULL DEFAULT true,
  promo_code           TEXT,
  promo_title          TEXT,
  promo_label          TEXT,
  promo_discount_cents INTEGER     NOT NULL DEFAULT 0 CHECK (promo_discount_cents >= 0),
  first_booking_only   BOOLEAN     NOT NULL DEFAULT true,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO site_marketing_settings (
  id,
  promo_enabled,
  promo_code,
  promo_title,
  promo_label,
  promo_discount_cents,
  first_booking_only
)
VALUES (
  1,
  true,
  'WELCOME25',
  'New Customer Offer',
  '$25 off your first booking',
  2500,
  true
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE site_marketing_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE tablename = 'site_marketing_settings'
      AND policyname = 'service_role_all_site_marketing_settings'
  ) THEN
    CREATE POLICY "service_role_all_site_marketing_settings" ON site_marketing_settings
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_discount_cents INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bookings_promo_discount_cents_nonnegative'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_promo_discount_cents_nonnegative
      CHECK (promo_discount_cents >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_promo_code
  ON bookings (promo_code)
  WHERE promo_code IS NOT NULL;
