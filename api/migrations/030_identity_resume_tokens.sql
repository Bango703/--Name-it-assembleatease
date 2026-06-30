-- ============================================================
-- Migration 030: Reusable Easer identity-resume links
-- Safe to re-run: IF NOT EXISTS on every column/index.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS identity_resume_token TEXT,
  ADD COLUMN IF NOT EXISTS identity_resume_token_created_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_identity_resume_token
  ON profiles(identity_resume_token)
  WHERE identity_resume_token IS NOT NULL;

-- Verification query
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'profiles'
--   AND column_name IN (
--     'identity_resume_token',
--     'identity_resume_token_created_at'
--   )
-- ORDER BY column_name;
