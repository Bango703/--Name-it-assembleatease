-- ============================================================
-- Migration 022: Sales tax remittance tracking
-- Owner-entered records of sales tax remitted to the Texas
-- Comptroller, so collected vs remitted vs outstanding can be
-- reconciled per filing period.
-- Does NOT change tax calculation, taxability, or the rate.
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS tax_remittances (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  jurisdiction  TEXT        NOT NULL DEFAULT 'TX',
  filing_period TEXT        NOT NULL,            -- 'YYYY-MM' or 'YYYY-Qn'
  amount_cents  INTEGER     NOT NULL CHECK (amount_cents >= 0),
  date_remitted DATE        NOT NULL,
  reference     TEXT,
  notes         TEXT,
  recorded_by   TEXT        NOT NULL DEFAULT 'owner',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_remittances_period
  ON tax_remittances (filing_period);
CREATE INDEX IF NOT EXISTS idx_tax_remittances_created
  ON tax_remittances (created_at DESC);

ALTER TABLE tax_remittances ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tax_remittances' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON tax_remittances
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
