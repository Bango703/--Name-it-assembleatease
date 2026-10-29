-- ============================================================
-- Migration 124: the owner can keep an Easer off a service
--
-- Owner, 2026-10-28 accountability table: "accepts jobs they clearly cannot
-- perform" and "repeated lack of required skill/tools". An Easer already
-- chooses the services they take (work_services, migration 110); this is the
-- owner's side: services the Easer is not offered, whatever they choose.
--
-- NULL or empty means no restriction, so nothing changes until the owner sets
-- one. Written only by the owner API (api/assembler/update.js, action
-- set_blocked_services) with the service role; update_own_easer_profile's
-- allowlist (migration 031) keeps it out of the Easer's reach. Dispatch reads
-- it through api/_easer-work-preferences.js and runs before this is applied.
-- ============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS owner_blocked_services TEXT[];

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (124, 'owner_blocked_services')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';
