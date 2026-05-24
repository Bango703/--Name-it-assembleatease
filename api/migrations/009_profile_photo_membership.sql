-- ============================================================
-- Migration 009: Profile Photo + Membership Columns
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- All statements use IF NOT EXISTS — safe to re-run
-- ============================================================

-- ── SECTION A: Missing profile columns ───────────────────────
-- These columns are referenced in frontend code but were never
-- added via a tracked migration.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_photo        TEXT         DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS has_membership       BOOLEAN      DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS membership_expires_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id   TEXT         DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT        DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_earned         INTEGER      DEFAULT 0;


-- ── SECTION B: Ensure profiles RLS UPDATE policy exists ──────
-- Without this policy, authenticated users cannot update their
-- own profile row even if the columns exist. PostgREST returns
-- success (no error) but 0 rows are written — silent failure.

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- SELECT: users can read their own row
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'users_can_read_own_profile'
  ) THEN
    CREATE POLICY "users_can_read_own_profile" ON profiles
      FOR SELECT
      USING (auth.uid() = id OR auth.role() = 'service_role');
  END IF;

  -- UPDATE: users can update their own row
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'users_can_update_own_profile'
  ) THEN
    CREATE POLICY "users_can_update_own_profile" ON profiles
      FOR UPDATE
      USING (auth.uid() = id)
      WITH CHECK (auth.uid() = id);
  END IF;

  -- Service role: full access for server-side API
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'service_role_all_profiles'
  ) THEN
    CREATE POLICY "service_role_all_profiles" ON profiles
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;


-- ── SECTION C: Verification queries ──────────────────────────
-- Run after migration to confirm all columns exist.

-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'profiles'
--   AND column_name IN (
--     'profile_photo', 'has_membership', 'membership_expires_at',
--     'stripe_customer_id', 'stripe_subscription_id', 'total_earned'
--   );

-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'profiles';
