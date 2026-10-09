-- 106: Demo Easer accounts (App Store review).
--
-- WHY. Apple's reviewer needs an Easer sign-in that can open every screen and
-- run a whole job, and must never be sent to a real customer's home. A profile
-- with is_demo_account = true can be offered, assigned, crewed and can accept
-- TEST bookings (bookings.is_test_booking, migration 094) only. The rule lives
-- in api/_demo-accounts.js and is enforced in dispatch, owner assign, crew and
-- accept-dispatch.
--
-- Easers cannot change this column themselves: guard_profile_self_update and
-- update_own_easer_profile (migration 031) allow only an explicit list of
-- fields, and this is not one of them.
--
-- Safe to run more than once. Until it runs, the code treats every account as
-- a normal Easer, so nothing changes before or during the rollout.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_demo_account BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.profiles.is_demo_account IS
  'Demo (App Review) Easer: may only be given test bookings. See api/_demo-accounts.js.';

-- Mark the App Review account. Profiles are guarded against non-service
-- writes, and the Supabase SQL editor runs statements separately, so the
-- service-role claim and the update share one DO block (same as 105).
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  UPDATE public.profiles
  SET is_demo_account = TRUE
  WHERE lower(email) = 'service+appreview@assembleatease.com'
    AND is_demo_account IS DISTINCT FROM TRUE;

  INSERT INTO public.platform_schema_state (migration_number, migration_name)
  VALUES (106, 'demo_easer_accounts')
  ON CONFLICT (migration_number) DO NOTHING;
END
$$;

NOTIFY pgrst, 'reload schema';
