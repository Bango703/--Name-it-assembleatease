-- ============================================================
-- Migration 005: Cron Health Log
-- Run in Supabase SQL Editor (safe to re-run: IF NOT EXISTS)
-- ============================================================

CREATE TABLE IF NOT EXISTS cron_log (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  cron_name         TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'ok',  -- ok | error | partial
  records_processed INTEGER     DEFAULT 0,
  error_text        TEXT,
  duration_ms       INTEGER,
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_log_name   ON cron_log(cron_name, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_log_ran_at ON cron_log(ran_at DESC);

-- Only keep 30 days of cron history — prevents unbounded growth
CREATE INDEX IF NOT EXISTS idx_cron_log_cleanup ON cron_log(ran_at);

ALTER TABLE cron_log ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='cron_log' AND policyname='service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON cron_log
      USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
  END IF;
END $$;

-- ── Verification ─────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='cron_log';
