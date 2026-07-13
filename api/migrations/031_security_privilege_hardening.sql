-- ============================================================
-- Migration 031: Profile/RPC privilege hardening
--
-- P0 controls:
-- 1. Remove the broad "update your own profile row" policy that let an
--    applicant self-approve, alter tier/membership, or spoof readiness.
-- 2. Replace it with one authenticated RPC that can update only the small
--    set of self-service profile fields used by the Easer UI.
-- 3. Revoke public execution of server-only financial/counter RPCs and set a
--    fixed search_path on SECURITY DEFINER functions.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_can_update_own_profile" ON public.profiles;

-- Remove any differently named UPDATE-only policy that may have been created
-- manually in an older environment. Service-role access is provided by the
-- existing ALL policy and is not affected.
DO $$
DECLARE
  v_policy text;
BEGIN
  FOR v_policy IN
    SELECT policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'profiles'
       AND cmd = 'UPDATE'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.profiles', v_policy);
  END LOOP;
END;
$$;

-- Defense in depth: even if a broad UPDATE policy is accidentally added
-- later, authenticated users still cannot change protected columns.
CREATE OR REPLACE FUNCTION public.guard_profile_self_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_allowed_keys CONSTANT text[] := ARRAY[
    'full_name', 'phone', 'city', 'state', 'zip', 'profile_photo', 'is_available'
  ];
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> OLD.id OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'Profile ownership is required' USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - v_allowed_keys) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed_keys) THEN
    RAISE EXCEPTION 'Protected profile fields cannot be changed by an Easer'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.identity_verified IS TRUE
     AND (NEW.full_name, NEW.city, NEW.state, NEW.zip)
         IS DISTINCT FROM (OLD.full_name, OLD.city, OLD.state, OLD.zip) THEN
    RAISE EXCEPTION 'Verified identity and location fields require owner review'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_available IS TRUE AND OLD.is_available IS NOT TRUE
     AND NOT COALESCE((
       NEW.role = 'assembler'
       AND NEW.status = 'active'
       AND NEW.application_status = 'approved'
       AND NEW.identity_verified IS TRUE
       AND NEW.contractor_agreement_signed_at IS NOT NULL
       AND NEW.code_of_conduct_agreed_at IS NOT NULL
     ), false) THEN
    RAISE EXCEPTION 'Easer is not ready to receive jobs' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_self_update ON public.profiles;
CREATE TRIGGER profiles_guard_self_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_self_update();

REVOKE ALL ON FUNCTION public.guard_profile_self_update() FROM PUBLIC, anon, authenticated;

-- The RPC accepts a JSON object so existing profile screens can make partial
-- updates without gaining write access to the profiles table. It always binds
-- the target row to auth.uid(); a browser-supplied user id is never accepted.
CREATE OR REPLACE FUNCTION public.update_own_easer_profile(p_updates jsonb)
RETURNS SETOF public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_allowed_keys CONSTANT text[] := ARRAY[
    'full_name', 'phone', 'city', 'state', 'zip', 'profile_photo', 'is_available'
  ];
  v_bad_keys text[];
BEGIN
  IF v_uid IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;

  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION 'A non-empty profile update object is required' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(key ORDER BY key)
    INTO v_bad_keys
    FROM jsonb_object_keys(p_updates) AS keys(key)
   WHERE NOT (key = ANY(v_allowed_keys));

  IF v_bad_keys IS NOT NULL THEN
    RAISE EXCEPTION 'Protected profile fields are not writable: %', array_to_string(v_bad_keys, ', ')
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_each(p_updates)
     WHERE key <> 'is_available'
       AND value <> 'null'::jsonb
       AND jsonb_typeof(value) <> 'string'
  ) THEN
    RAISE EXCEPTION 'Profile text fields must be strings or null' USING ERRCODE = '22023';
  END IF;

  IF p_updates ? 'is_available'
     AND (p_updates->'is_available' = 'null'::jsonb OR jsonb_typeof(p_updates->'is_available') <> 'boolean') THEN
    RAISE EXCEPTION 'is_available must be true or false' USING ERRCODE = '22023';
  END IF;

  IF p_updates ? 'full_name' AND length(btrim(COALESCE(p_updates->>'full_name', ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Full name must be between 1 and 120 characters' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'phone' AND length(COALESCE(p_updates->>'phone', '')) > 40 THEN
    RAISE EXCEPTION 'Phone number is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'city' AND length(COALESCE(p_updates->>'city', '')) > 120 THEN
    RAISE EXCEPTION 'City is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'state' AND length(COALESCE(p_updates->>'state', '')) > 32 THEN
    RAISE EXCEPTION 'State is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'zip' AND length(COALESCE(p_updates->>'zip', '')) > 10 THEN
    RAISE EXCEPTION 'ZIP is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'profile_photo' AND length(COALESCE(p_updates->>'profile_photo', '')) > 1500000 THEN
    RAISE EXCEPTION 'Profile photo is too large' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'profile_photo'
     AND NULLIF(p_updates->>'profile_photo', '') IS NOT NULL
     AND (p_updates->>'profile_photo') !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
     AND (p_updates->>'profile_photo') !~ '^https://[^"''<>[:space:]]+$' THEN
    RAISE EXCEPTION 'Profile photo must be a safe image data URL or HTTPS URL'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = v_uid
     AND role = 'assembler'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Easer profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_profile.identity_verified IS TRUE
     AND p_updates ?| ARRAY['full_name', 'city', 'state', 'zip'] THEN
    RAISE EXCEPTION 'Verified identity and location fields require owner review'
      USING ERRCODE = '42501';
  END IF;

  IF p_updates ? 'is_available'
     AND (p_updates->>'is_available')::boolean IS TRUE
     AND NOT COALESCE((
       v_profile.status = 'active'
       AND v_profile.application_status = 'approved'
       AND v_profile.identity_verified IS TRUE
       AND v_profile.contractor_agreement_signed_at IS NOT NULL
       AND v_profile.code_of_conduct_agreed_at IS NOT NULL
     ), false) THEN
    RAISE EXCEPTION 'Easer is not ready to receive jobs' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
     SET full_name = CASE WHEN p_updates ? 'full_name' THEN btrim(p_updates->>'full_name') ELSE full_name END,
         phone = CASE WHEN p_updates ? 'phone' THEN NULLIF(btrim(p_updates->>'phone'), '') ELSE phone END,
         city = CASE WHEN p_updates ? 'city' THEN NULLIF(btrim(p_updates->>'city'), '') ELSE city END,
         state = CASE WHEN p_updates ? 'state' THEN NULLIF(btrim(p_updates->>'state'), '') ELSE state END,
         zip = CASE WHEN p_updates ? 'zip' THEN NULLIF(btrim(p_updates->>'zip'), '') ELSE zip END,
         profile_photo = CASE WHEN p_updates ? 'profile_photo' THEN NULLIF(p_updates->>'profile_photo', '') ELSE profile_photo END,
         is_available = CASE WHEN p_updates ? 'is_available' THEN (p_updates->>'is_available')::boolean ELSE is_available END
   WHERE id = v_uid
   RETURNING * INTO v_profile;

  RETURN NEXT v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_easer_profile(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_own_easer_profile(jsonb) TO authenticated;

-- PostgreSQL grants function execution to PUBLIC by default. All functions in
-- this list are invoked only by service-key server code and must not be callable
-- through the anonymous/authenticated PostgREST API.
DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY(ARRAY[
         'increment_completed_jobs',
         'increment_active_jobs',
         'decrement_active_jobs',
         'increment_profile_counters',
         'record_booking_payout',
         'assemblecash_available_balance',
         'assemblecash_try_redeem',
         'customer_active_membership'
       ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_function);
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', v_function);
  END LOOP;
END;
$$;

-- Verification (run after applying):
-- SELECT policyname, cmd FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'profiles';
-- SELECT routine_name, grantee, privilege_type
--   FROM information_schema.routine_privileges
--  WHERE specific_schema = 'public'
--    AND routine_name IN ('update_own_easer_profile', 'assemblecash_try_redeem', 'record_booking_payout')
--  ORDER BY routine_name, grantee;
