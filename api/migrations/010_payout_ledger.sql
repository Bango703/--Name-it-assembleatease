-- ============================================================
-- Migration 010: Immutable payout ledger
-- Records each assembler payout as a durable row and updates the
-- related booking in the same database transaction via RPC.
-- ============================================================

CREATE TABLE IF NOT EXISTS payout_ledger (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id      UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  booking_ref     TEXT        NOT NULL,
  assembler_id    UUID        NOT NULL,
  assembler_name  TEXT,
  assembler_tier  TEXT,
  service         TEXT,
  booking_date    TEXT,
  amount_charged  INTEGER     NOT NULL DEFAULT 0,
  assembler_due   INTEGER     NOT NULL DEFAULT 0,
  payout_amount   INTEGER     NOT NULL,
  platform_revenue INTEGER    NOT NULL,
  payout_notes    TEXT,
  recorded_by     TEXT        NOT NULL DEFAULT 'owner',
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_ledger_booking_unique
  ON payout_ledger(booking_id);
CREATE INDEX IF NOT EXISTS idx_payout_ledger_assembler
  ON payout_ledger(assembler_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_ledger_recorded_at
  ON payout_ledger(recorded_at DESC);

ALTER TABLE payout_ledger ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'payout_ledger' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON payout_ledger
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION record_booking_payout(
  p_booking_id UUID,
  p_payout_amount_cents INTEGER,
  p_notes TEXT DEFAULT NULL,
  p_recorded_by TEXT DEFAULT 'owner'
)
RETURNS TABLE (
  booking_id UUID,
  booking_ref TEXT,
  assembler_id UUID,
  assembler_name TEXT,
  assembler_tier TEXT,
  payout_amount INTEGER,
  platform_revenue INTEGER,
  amount_charged INTEGER,
  assembler_due INTEGER,
  recorded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  booking_row bookings%ROWTYPE;
  payout_amount_cents INTEGER;
  amount_charged_cents INTEGER;
  assembler_due_cents INTEGER;
  platform_revenue_cents INTEGER;
BEGIN
  SELECT *
    INTO booking_row
    FROM bookings
   WHERE id = p_booking_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF booking_row.status <> 'completed' THEN
    RAISE EXCEPTION 'Only completed bookings can be paid out. Current status: %', booking_row.status USING ERRCODE = '22000';
  END IF;

  IF booking_row.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No assembler assigned to this booking' USING ERRCODE = '22000';
  END IF;

  IF booking_row.payout_status = 'paid' THEN
    RAISE EXCEPTION 'Payout already recorded for this booking.' USING ERRCODE = '23505';
  END IF;

  payout_amount_cents := COALESCE(p_payout_amount_cents, booking_row.assembler_due);
  IF payout_amount_cents IS NULL OR payout_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Cannot determine payout amount — no assembler_due recorded and no amount supplied' USING ERRCODE = '22000';
  END IF;

  amount_charged_cents := COALESCE(booking_row.amount_charged, booking_row.total_price::INTEGER, 0);
  assembler_due_cents := COALESCE(booking_row.assembler_due, 0);
  platform_revenue_cents := amount_charged_cents - payout_amount_cents;

  UPDATE bookings
     SET payout_amount    = payout_amount_cents,
         paid_out_at      = NOW(),
         payout_notes     = p_notes,
         payout_status    = 'paid',
         platform_revenue = platform_revenue_cents
   WHERE id = booking_row.id;

  INSERT INTO payout_ledger (
    booking_id,
    booking_ref,
    assembler_id,
    assembler_name,
    assembler_tier,
    service,
    booking_date,
    amount_charged,
    assembler_due,
    payout_amount,
    platform_revenue,
    payout_notes,
    recorded_by
  ) VALUES (
    booking_row.id,
    booking_row.ref,
    booking_row.assembler_id,
    booking_row.assembler_name,
    booking_row.assembler_tier,
    booking_row.service,
    booking_row.date::text,
    amount_charged_cents,
    assembler_due_cents,
    payout_amount_cents,
    platform_revenue_cents,
    p_notes,
    COALESCE(p_recorded_by, 'owner')
  );

  RETURN QUERY
    SELECT
      booking_row.id,
      booking_row.ref,
      booking_row.assembler_id,
      booking_row.assembler_name,
      booking_row.assembler_tier,
      payout_amount_cents,
      platform_revenue_cents,
      amount_charged_cents,
      assembler_due_cents,
      NOW();
END;
$$;