-- ============================================================
-- Migration 017: Nationwide market demand requests
-- Purpose: Capture out-of-active-market demand without creating
-- a guaranteed booking, payment authorization, or dispatch record.
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS market_requests (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  request_ref          TEXT        NOT NULL UNIQUE,
  status               TEXT        NOT NULL DEFAULT 'new',
  market_type          TEXT        NOT NULL DEFAULT 'emerging',
  source               TEXT        NOT NULL DEFAULT 'booking_out_of_market',

  customer_name        TEXT        NOT NULL,
  customer_email       TEXT        NOT NULL,
  customer_phone       TEXT        NOT NULL,

  city                 TEXT        NOT NULL,
  state                TEXT        NOT NULL,
  zip_code             TEXT        NOT NULL,
  address              TEXT,

  requested_service    TEXT        NOT NULL,
  services             TEXT[]      NOT NULL DEFAULT '{}',
  requested_date       DATE,
  desired_time         TEXT,
  details              TEXT,
  item_summary         JSONB       NOT NULL DEFAULT '{}'::jsonb,

  estimated_revenue    INTEGER     NOT NULL DEFAULT 0,
  converted_booking_id UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  converted_at         TIMESTAMPTZ,
  last_contacted_at    TIMESTAMPTZ,
  owner_notes          TEXT,
  request_timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT market_requests_status_valid CHECK (
    status IN ('new', 'contacted', 'waiting_supply', 'converted', 'closed')
  ),
  CONSTRAINT market_requests_market_type_valid CHECK (
    market_type IN ('active', 'emerging')
  ),
  CONSTRAINT market_requests_revenue_nonnegative CHECK (estimated_revenue >= 0)
);

CREATE INDEX IF NOT EXISTS idx_market_requests_created_at
  ON market_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_requests_status
  ON market_requests (status);

CREATE INDEX IF NOT EXISTS idx_market_requests_market
  ON market_requests (state, city);

CREATE INDEX IF NOT EXISTS idx_market_requests_zip
  ON market_requests (zip_code);

CREATE INDEX IF NOT EXISTS idx_market_requests_service
  ON market_requests (requested_service);

ALTER TABLE market_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE tablename = 'market_requests'
      AND policyname = 'service_role_all_market_requests'
  ) THEN
    CREATE POLICY "service_role_all_market_requests" ON market_requests
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
