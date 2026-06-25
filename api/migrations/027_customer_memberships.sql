-- ============================================================
-- Migration 027: Customer memberships — Setup Club + Move-In Pass
-- DISTINCT from Easer membership (profiles.has_membership / the 25%-vs-30%
-- platform-fee tier). This table is CUSTOMER-side and must NEVER feed
-- getPlatformFeePct() or the Easer payout split.
-- Keyed by normalized lowercase email (there is no customer login). Stripe
-- fields stay NULL until Setup Club / Move-In Pass billing is wired — a row can
-- exist (e.g. a comped membership) without them.
--   setup_club_monthly / setup_club_annual : recurring (current_period_end)
--   move_in_pass                           : one-time, 30-day (expires_at)
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_memberships (
  id                     UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_email         TEXT        NOT NULL,                       -- normalized lowercase
  plan                   TEXT        NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'active',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  welcome_credit_cents   INTEGER     NOT NULL DEFAULT 0,             -- e.g. Move-In Pass $25 seed, annual welcome credit
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end     TIMESTAMPTZ,                                -- recurring plans
  expires_at             TIMESTAMPTZ,                                -- move_in_pass / hard expiry
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_membership_plan_chk
    CHECK (plan IN ('setup_club_monthly','setup_club_annual','move_in_pass')),
  CONSTRAINT customer_membership_status_chk
    CHECK (status IN ('active','canceled','expired','past_due'))
);

CREATE INDEX IF NOT EXISTS idx_customer_memberships_email_status
  ON customer_memberships(customer_email, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_memberships_sub_unique
  ON customer_memberships(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE customer_memberships ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'customer_memberships' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON customer_memberships
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- Returns the active plan for an email (most recent), or NULL. Active = status
-- 'active' AND not past its expiry. Used to apply member benefits server-side.
CREATE OR REPLACE FUNCTION customer_active_membership(p_email TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT plan
  FROM customer_memberships
  WHERE customer_email = LOWER(TRIM(p_email))
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY started_at DESC
  LIMIT 1;
$$;
