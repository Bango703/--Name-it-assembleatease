-- ============================================================
-- Migration 001: Auto-Dispatch Engine Schema
-- Run once in Supabase SQL editor (safe to re-run: IF NOT EXISTS)
-- ============================================================

-- ── dispatch_offers: per-Easer offer tracking ────────────────
CREATE TABLE IF NOT EXISTS dispatch_offers (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id        UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  easer_id          UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dispatch_score    INTEGER     NOT NULL DEFAULT 0,
  offer_status      TEXT        NOT NULL DEFAULT 'sent',
    -- sent | accepted | declined | expired | cancelled | superseded
  token             TEXT        NOT NULL,
  attempt_number    INTEGER     NOT NULL DEFAULT 1,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  accepted_at       TIMESTAMPTZ,
  declined_at       TIMESTAMPTZ,
  timed_out_at      TIMESTAMPTZ,
  decline_reason    TEXT,
  notification_sent BOOLEAN     DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(token)
);

CREATE INDEX IF NOT EXISTS idx_do_booking   ON dispatch_offers(booking_id);
CREATE INDEX IF NOT EXISTS idx_do_easer     ON dispatch_offers(easer_id);
CREATE INDEX IF NOT EXISTS idx_do_token     ON dispatch_offers(token);
CREATE INDEX IF NOT EXISTS idx_do_expires   ON dispatch_offers(expires_at) WHERE offer_status = 'sent';
CREATE INDEX IF NOT EXISTS idx_do_status    ON dispatch_offers(offer_status);

-- ── bookings: new dispatch control columns ───────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispatch_attempt    INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS needs_manual_dispatch BOOLEAN DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispatch_paused     BOOLEAN DEFAULT false;

-- ── profiles: Easer performance metrics ─────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS acceptance_rate          NUMERIC(5,2) DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS active_jobs_today        INTEGER      DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_dispatch_declined_at TIMESTAMPTZ  DEFAULT NULL;

-- ── RLS: allow service role full access ──────────────────────
ALTER TABLE dispatch_offers ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'dispatch_offers' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON dispatch_offers
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
