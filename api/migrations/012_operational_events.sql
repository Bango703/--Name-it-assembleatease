-- ============================================================
-- Migration 012: Operational Request Telemetry
-- Run in Supabase SQL Editor (safe to re-run: IF NOT EXISTS)
-- ============================================================

CREATE TABLE IF NOT EXISTS operational_events (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id      TEXT        NOT NULL,
  event_type      TEXT        NOT NULL,
  route           TEXT        NOT NULL,
  method          TEXT        NOT NULL,
  deployment_id   TEXT,
  commit_sha      TEXT,
  environment     TEXT,
  app_version     TEXT,
  actor_role      TEXT        NOT NULL,
  actor_id_hash   TEXT,
  booking_hash    TEXT,
  offer_hash      TEXT,
  stage           TEXT,
  status_code     INTEGER,
  reason_code     TEXT,
  reason_detail   TEXT,
  mutation_result TEXT,
  latency_ms      INTEGER,
  payload         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_oe_created
  ON operational_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oe_event_type
  ON operational_events(event_type);

CREATE INDEX IF NOT EXISTS idx_oe_route_created
  ON operational_events(route, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oe_status_created
  ON operational_events(status_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oe_reason_code
  ON operational_events(reason_code);

CREATE INDEX IF NOT EXISTS idx_oe_deployment_id
  ON operational_events(deployment_id);

CREATE INDEX IF NOT EXISTS idx_oe_booking_hash
  ON operational_events(booking_hash)
  WHERE booking_hash IS NOT NULL;

ALTER TABLE operational_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE tablename = 'operational_events'
      AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON operational_events
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- Retention notes:
-- - Raw operational_events target retention: 30 days.
-- - runtime_error rows can be retained up to 90 days if volume remains low.
-- - Keep long-term analytics in rollups/views, not indefinite raw retention.
