-- ============================================================
-- Migration 134: Easer referral rewards
--
-- Owner, 2026-11-21: "let's work on getting easers ... maybe a referral
-- something". An Easer shares a personal link; when the person they refer
-- completes 2 paid jobs within 90 days of applying, the referrer earns a
-- reward (EASER_REFERRAL_POLICY in api/_easer-referrals.js: $75).
--
--   profiles.referral_code         the Easer's code, e.g. PHIL482 (unique,
--                                  case-insensitive), created on first use.
--   profiles.referred_by_easer_id  who referred this applicant, set once at
--                                  application from the link's attribution.
--   easer_referral_rewards         one row per referred applicant:
--                                  pending -> earned -> paid, or void.
--
-- Server only (service role): RLS on, no policies, no grants to app roles.
-- The code reads all of this defensively and runs before it is applied.
-- ============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referral_code TEXT,
  ADD COLUMN IF NOT EXISTS referred_by_easer_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_referral_code
  ON public.profiles (upper(referral_code)) WHERE referral_code IS NOT NULL;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_referral_code_format;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_referral_code_format
  CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z]{1,8}[0-9]{3}$');

CREATE TABLE IF NOT EXISTS public.easer_referral_rewards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  referee_id       uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  referral_code    text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'earned', 'paid', 'void')),
  amount_cents     integer NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 50000),
  qualifying_jobs  integer NOT NULL DEFAULT 2 CHECK (qualifying_jobs >= 1),
  referred_at      timestamptz NOT NULL DEFAULT now(),
  earned_at        timestamptz,
  paid_at          timestamptz,
  paid_method      text CHECK (paid_method IS NULL OR paid_method IN ('stripe_transfer', 'outside_stripe')),
  paid_reference   text,
  void_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_id <> referee_id),
  CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND paid_method IS NOT NULL)),
  CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_easer_referral_rewards_referrer ON public.easer_referral_rewards (referrer_id, status);
CREATE INDEX IF NOT EXISTS idx_easer_referral_rewards_status ON public.easer_referral_rewards (status, referred_at);
ALTER TABLE public.easer_referral_rewards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.easer_referral_rewards FROM PUBLIC, anon, authenticated;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (134, 'easer_referrals')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';
