-- 061_same_day_service_fee.sql
-- Same-day service fee — additive columns only.
--
-- The fee is a premium the customer pays when the appointment is TODAY. It is an
-- ADDITIVE layer on top of the existing 30% / 70% base split: it NEVER enters
-- computeBookingSplit. Of the fee the Easer keeps a fixed rush bonus and the
-- business keeps the remainder. Both amounts are stored here so completion,
-- payout, and every dashboard read one truth.
--
-- Safe to re-run. Existing rows and the canonical money split are untouched
-- (both columns default 0, so every prior and future non-same-day booking is
-- exactly as before). Apply in the Supabase SQL editor.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS same_day_fee_cents         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS same_day_easer_bonus_cents INTEGER NOT NULL DEFAULT 0;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (61, 'same_day_service_fee')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
