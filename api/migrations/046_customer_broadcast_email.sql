-- ============================================================
-- Migration 046: Customer broadcast email (announcements + marketing)
--
-- Adds the persistent state a compliant mass-email tool needs, separate from the
-- transactional notification_log:
--   * email_suppressions   — anyone who unsubscribed. Every broadcast filters
--                            against this. An address here is NEVER emailed a
--                            broadcast again, regardless of audience.
--   * email_marketing_optins — addresses that affirmatively opted in to
--                              marketing/promos (populated by the booking opt-in
--                              checkbox). Announcements go to past customers;
--                              promos go ONLY to this list.
--   * email_broadcasts     — an audit row per send (audience, counts, who/when).
--
-- All three are service-role only; the owner send endpoint and the public
-- unsubscribe endpoint both use the service client. No PII beyond email/name.
-- Apply after migration 045. Safe to re-run.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.email_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'unsubscribe',
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.email_marketing_optins (
  email TEXT PRIMARY KEY,
  name TEXT,
  source TEXT,
  opted_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.email_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience TEXT NOT NULL CHECK (audience IN ('past_customers', 'marketing_optins')),
  subject TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_broadcasts_created_at
  ON public.email_broadcasts (created_at DESC);

-- Service-role only. The tables carry opt-out and consent truth; no anon or
-- authenticated (Easer) role should read or write them.
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_marketing_optins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_broadcasts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.email_suppressions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.email_marketing_optins FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.email_broadcasts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.email_suppressions TO service_role;
GRANT ALL ON TABLE public.email_marketing_optins TO service_role;
GRANT ALL ON TABLE public.email_broadcasts TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (46, 'customer_broadcast_email')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
