-- 062_easer_tier_program.sql
-- Easer tier program ("The Pro Path") — tracking columns for the full engine:
-- promotion timestamp + the demotion grace window. Additive; safe to re-run.
-- Existing tiers/rows are untouched (both columns default NULL). See
-- business-artifacts/easer-tier-program.md.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tier_updated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tier_grace_started_at TIMESTAMPTZ;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (62, 'easer_tier_program')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
