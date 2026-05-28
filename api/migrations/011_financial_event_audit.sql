-- ============================================================
-- Migration 011: Financial event audit + webhook dedupe store
-- Creates a durable event log for Stripe financial mutations and
-- idempotent Stripe webhook event processing by stripe_event_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS financial_event_audit (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  stripe_event_id   TEXT        UNIQUE,
  booking_id        UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  payment_intent_id TEXT,
  refund_id         TEXT,
  event_type        TEXT        NOT NULL,
  event_source      TEXT        NOT NULL DEFAULT 'api',
  event_created_at  TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status            TEXT        NOT NULL DEFAULT 'processed',
  idempotency_key   TEXT,
  metadata          JSONB,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_event_audit_booking
  ON financial_event_audit(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_event_audit_pi
  ON financial_event_audit(payment_intent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_event_audit_type
  ON financial_event_audit(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_event_audit_status
  ON financial_event_audit(status, created_at DESC);

ALTER TABLE financial_event_audit ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'financial_event_audit' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON financial_event_audit
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
