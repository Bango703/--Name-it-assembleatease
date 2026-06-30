-- ============================================================
-- Migration 029: Assembler onboarding legal + identity columns
-- Safe to re-run: IF NOT EXISTS on every column.
--
-- Purpose:
-- 1. Persist contractor-agreement / code-of-conduct evidence
-- 2. Persist optional Stripe Identity state fields used by owner tools
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS code_of_conduct_agreed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contractor_agreement_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contractor_agreement_version TEXT,
  ADD COLUMN IF NOT EXISTS contractor_agreement_ip TEXT,
  ADD COLUMN IF NOT EXISTS contractor_agreement_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS contractor_agreement_signed_name TEXT,
  ADD COLUMN IF NOT EXISTS id_verification_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_identity_session_id TEXT;

-- Optional index for owner-side identity filtering / debugging
CREATE INDEX IF NOT EXISTS idx_profiles_id_verification_status
  ON profiles(id_verification_status);

-- Verification query
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'profiles'
--   AND column_name IN (
--     'code_of_conduct_agreed_at',
--     'contractor_agreement_signed_at',
--     'contractor_agreement_version',
--     'contractor_agreement_ip',
--     'contractor_agreement_user_agent',
--     'contractor_agreement_signed_name',
--     'id_verification_status',
--     'stripe_identity_session_id'
--   )
-- ORDER BY column_name;
