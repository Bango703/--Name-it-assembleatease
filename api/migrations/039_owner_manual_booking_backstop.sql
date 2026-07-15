-- ============================================================
-- Migration 039: Owner manual booking schema backstop
--
-- Purpose:
-- Re-assert owner-manual booking columns/checks in case migration 038 was
-- skipped in any environment. This migration is additive and idempotent.
-- ============================================================

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'online',
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS payment_collected BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_collected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_collected_by TEXT,
  ADD COLUMN IF NOT EXISTS price_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS standard_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS owner_booking_note TEXT;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_source_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_source_check
  CHECK (source IN ('online', 'owner_manual'));

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payment_method_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_method_check
  CHECK (
    payment_method IS NULL
    OR payment_method IN ('stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice')
  );

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_standard_price_cents_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_standard_price_cents_check
  CHECK (standard_price_cents IS NULL OR standard_price_cents >= 0);

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payment_collected_truth_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_collected_truth_check
  CHECK (
    (payment_collected IS TRUE AND payment_collected_at IS NOT NULL)
    OR (payment_collected IS NOT TRUE AND payment_collected_at IS NULL AND payment_collected_by IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_bookings_owner_manual_open
  ON public.bookings (created_at DESC)
  WHERE source = 'owner_manual' AND status = 'confirmed';

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (39, 'owner_manual_booking_backstop')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
