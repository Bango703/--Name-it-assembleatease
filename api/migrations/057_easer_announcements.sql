-- 057_easer_announcements.sql
-- Reusable Easer announcement / required-action engine.
-- First use case: drive Easers to complete Stripe Connect payout setup, without
-- blocking their job offers. Built once, reused for any future required action
-- (agreement version bump, policy change, feature launch).
--
-- Apply in the Supabase SQL editor. Idempotent (safe to re-run).

BEGIN;

CREATE TABLE IF NOT EXISTS easer_announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT UNIQUE NOT NULL,
  type          TEXT NOT NULL DEFAULT 'required_action'
                  CHECK (type IN ('required_action', 'info')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  action_label  TEXT,
  action_url    TEXT,
  -- Named rule the engine understands (see api/_announcements.js TARGET_RULES).
  target_rule   TEXT NOT NULL DEFAULT 'payout_setup_incomplete',
  -- Whether an incomplete required action removes the Easer from dispatch.
  -- Default false: Easers keep getting/accepting jobs; earnings just hold.
  blocks_offers BOOLEAN NOT NULL DEFAULT false,
  channels      TEXT[] NOT NULL DEFAULT ARRAY['email', 'in_app', 'push']::TEXT[],
  reminder_days INTEGER[] NOT NULL DEFAULT ARRAY[0, 2, 5]::INTEGER[],
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'ended')),
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at       TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS easer_announcement_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id   UUID NOT NULL REFERENCES easer_announcements(id) ON DELETE CASCADE,
  easer_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channels_sent     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  first_notified_at TIMESTAMPTZ,
  last_reminded_at  TIMESTAMPTZ,
  reminder_count    INTEGER NOT NULL DEFAULT 0,
  completed_at      TIMESTAMPTZ,
  dismissed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, easer_id)
);

CREATE INDEX IF NOT EXISTS idx_easer_ann_deliveries_ann   ON easer_announcement_deliveries(announcement_id);
CREATE INDEX IF NOT EXISTS idx_easer_ann_deliveries_easer ON easer_announcement_deliveries(easer_id);
CREATE INDEX IF NOT EXISTS idx_easer_ann_deliveries_open  ON easer_announcement_deliveries(announcement_id) WHERE completed_at IS NULL;

ALTER TABLE public.easer_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.easer_announcement_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.easer_announcements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.easer_announcement_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.easer_announcements TO service_role;
GRANT ALL ON TABLE public.easer_announcement_deliveries TO service_role;

-- Seed the payout-setup required-action campaign (idempotent).
-- It only actually targets anyone when Stripe Connect is enabled AND an active
-- Easer has not finished payout setup (see the engine's target rule), so seeding
-- it 'active' is safe even while Connect is still off.
INSERT INTO easer_announcements
  (key, type, title, body, action_label, action_url, target_rule, blocks_offers, channels, reminder_days, status, created_by)
VALUES (
  'payout_setup',
  'required_action',
  'Set up your payouts',
  'To get paid for your completed jobs, set up secure payouts. You enter your bank details directly with Stripe — it takes a few minutes and AssembleAtEase never stores them. You can keep accepting jobs in the meantime; your earnings are held safely until your payout account is ready.',
  'Set up payouts',
  '/assembler/payouts',
  'payout_setup_incomplete',
  false,
  ARRAY['email', 'in_app', 'push']::TEXT[],
  ARRAY[0, 2, 5]::INTEGER[],
  'active',
  'system'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (57, 'easer_announcements')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
