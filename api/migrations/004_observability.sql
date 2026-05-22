-- ============================================================
-- Migration 004: Operational Observability
-- Run in Supabase SQL Editor (safe to re-run: IF NOT EXISTS)
-- ============================================================

-- ── activity_logs ─────────────────────────────────────────────────────────
-- Referenced by api/booking/_activity.js and api/booking/activity.js
-- since initial build but never formally migrated.
CREATE TABLE IF NOT EXISTS activity_logs (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id  UUID        REFERENCES bookings(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,
  actor_type  TEXT,                   -- owner | easer | customer | system | cron
  actor_id    UUID,
  actor_name  TEXT,
  description TEXT        NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_al_booking ON activity_logs(booking_id);
CREATE INDEX IF NOT EXISTS idx_al_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_al_type    ON activity_logs(event_type);

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='activity_logs' AND policyname='service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON activity_logs
      USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
  END IF;
END $$;


-- ── notification_log ──────────────────────────────────────────────────────
-- Tracks every email and push attempt — success and failure.
-- Powers the Timeline tab notification layer and owner alerts for silent failures.
CREATE TABLE IF NOT EXISTS notification_log (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id        UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  channel           TEXT        NOT NULL,  -- email | push
  notification_type TEXT        NOT NULL,  -- dispatch_offer | job_accepted | completion | etc.
  recipient_type    TEXT,                  -- customer | easer | owner
  recipient_email   TEXT,
  recipient_user_id UUID,
  subject           TEXT,
  status            TEXT        NOT NULL DEFAULT 'sent',  -- sent | failed
  provider_id       TEXT,                  -- Resend message ID
  error_text        TEXT,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nl_booking  ON notification_log(booking_id);
CREATE INDEX IF NOT EXISTS idx_nl_sent_at  ON notification_log(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_nl_status   ON notification_log(status) WHERE status='failed';
CREATE INDEX IF NOT EXISTS idx_nl_type     ON notification_log(notification_type);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='notification_log' AND policyname='service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON notification_log
      USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
  END IF;
END $$;


-- ── Verification ─────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN ('activity_logs','notification_log')
--   ORDER BY table_name;
-- Expected: 2 rows
