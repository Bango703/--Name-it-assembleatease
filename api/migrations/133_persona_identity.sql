-- ============================================================
-- Migration 133: Persona as an identity verification provider
--
-- Owner, 2026-11-21: set up Persona for Easer ID checks. Stripe Identity stays
-- the default; Persona is used only when IDENTITY_PROVIDER=persona and its keys
-- are set (api/_persona.js). Apply this BEFORE setting IDENTITY_PROVIDER=persona:
-- without these columns the code falls back to Stripe on every attempt.
--
--   persona_inquiry_id  the applicant's current Persona inquiry (inq_...). The
--                       webhook ignores events for any other inquiry.
--   identity_provider   which provider holds the current check: 'stripe' or
--                       'persona'. NULL on profiles from before this migration
--                       (Stripe).
--
-- identity_verified stays the ONE answer to "is this Easer verified", written
-- only by a provider's signed webhook (api/_identity-outcome.js).
-- ============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS persona_inquiry_id TEXT,
  ADD COLUMN IF NOT EXISTS identity_provider TEXT;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_identity_provider_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_identity_provider_check
  CHECK (identity_provider IS NULL OR identity_provider IN ('stripe', 'persona'));

CREATE INDEX IF NOT EXISTS idx_profiles_persona_inquiry
  ON public.profiles (persona_inquiry_id) WHERE persona_inquiry_id IS NOT NULL;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (133, 'persona_identity')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';
