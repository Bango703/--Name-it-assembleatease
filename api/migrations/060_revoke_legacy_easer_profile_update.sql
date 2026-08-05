-- AssembleAtEase migration 060
-- Apply only after the migration-059 Easer frontend is live. Removes direct
-- browser access to the legacy full-row profile update response.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NULL
     OR to_regprocedure('public.update_own_easer_profile(jsonb)') IS NULL
     OR to_regprocedure('public.update_own_easer_profile_safe(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Apply migration 059 before migration 060';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_schema_state schema_state
     WHERE schema_state.migration_number = 59
  ) THEN
    RAISE EXCEPTION 'Migration 059 must be recorded before migration 060';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_easer_profile(jsonb) FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (60, 'revoke_legacy_easer_profile_update')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;