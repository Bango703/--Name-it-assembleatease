-- AssembleAtEase migration 059
-- Keeps browser profile updates auth-bound while returning only fields needed
-- to repaint Easer-facing profile and availability state.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.platform_schema_state') IS NULL
     OR to_regprocedure('public.update_own_easer_profile(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Apply launch migrations through 058 before migration 059';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_schema_state schema_state
     WHERE schema_state.migration_number = 58
  ) THEN
    RAISE EXCEPTION 'Migration 058 must be recorded before migration 059';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_own_easer_profile_safe(p_updates jsonb)
RETURNS TABLE (
  id uuid,
  full_name text,
  phone text,
  city text,
  state text,
  zip text,
  profile_photo text,
  is_available boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
BEGIN
  SELECT updated_profile.*
    INTO v_profile
    FROM public.update_own_easer_profile(p_updates) AS updated_profile
   LIMIT 1;

  IF v_profile.id IS NULL THEN
    RAISE EXCEPTION 'Easer profile could not be updated' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT
    v_profile.id,
    v_profile.full_name,
    v_profile.phone,
    v_profile.city,
    v_profile.state,
    v_profile.zip,
    v_profile.profile_photo,
    v_profile.is_available;
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_easer_profile_safe(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_own_easer_profile_safe(jsonb) TO authenticated;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (59, 'easer_profile_update_projection')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;