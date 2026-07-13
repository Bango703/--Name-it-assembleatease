-- ============================================================
-- Migration 032: Payment truth and customer consent hardening
-- Apply after migration 031 and before deploying the matching APIs.
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guest_mutation_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS quote_amount_cents INTEGER,
  ADD COLUMN IF NOT EXISTS quote_subtotal_cents INTEGER,
  ADD COLUMN IF NOT EXISTS quote_tax_cents INTEGER,
  ADD COLUMN IF NOT EXISTS quote_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS quote_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_approval_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_terms_version TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_id TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_easer_due_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_easer_payout_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_bank_payout_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_bank_payout_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_bank_payout_paid_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_quote_token_hash
  ON bookings (quote_token_hash)
  WHERE quote_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_guest_mutation_token_hash
  ON bookings (guest_mutation_token_hash)
  WHERE guest_mutation_token_hash IS NOT NULL;

-- Manual payout remains the launch source of truth. The caller-provided amount
-- must exactly equal the canonical server-calculated due, and customer funds
-- must already be captured (including a captured cancellation fee).
-- Migration 010 created a four-argument overload. Drop it before installing
-- the canonical five-argument function so default arguments cannot make RPC
-- resolution ambiguous or leave the older, weaker payout path callable.
DROP FUNCTION IF EXISTS public.record_booking_payout(UUID, INTEGER, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.record_booking_payout(
  p_booking_id          UUID,
  p_payout_amount_cents INTEGER,
  p_notes               TEXT    DEFAULT NULL,
  p_recorded_by         TEXT    DEFAULT 'owner',
  p_payout_method       TEXT    DEFAULT 'manual'
)
RETURNS TABLE (
  booking_id       UUID,
  booking_ref      TEXT,
  assembler_id     UUID,
  assembler_name   TEXT,
  assembler_tier   TEXT,
  payout_amount    INTEGER,
  platform_revenue INTEGER,
  amount_charged   INTEGER,
  assembler_due    INTEGER,
  recorded_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_row            bookings%ROWTYPE;
  canonical_due_cents    INTEGER;
  amount_charged_cents   INTEGER;
  net_captured_cents     INTEGER;
  remaining_tax_cents    INTEGER;
  stripe_fee_cents       INTEGER;
  platform_revenue_cents INTEGER;
BEGIN
  SELECT * INTO booking_row FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF booking_row.status = 'completed' THEN
    IF booking_row.payment_status NOT IN ('captured', 'partially_refunded') THEN
      RAISE EXCEPTION 'Customer payment must be captured before payout. Current payment status: %', booking_row.payment_status USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.assembler_due, 0);
  ELSIF booking_row.status = 'cancelled' THEN
    IF booking_row.payment_status <> 'cancellation_fee_captured' THEN
      RAISE EXCEPTION 'Cancellation fee must be captured before cancellation earnings can be paid' USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.cancellation_easer_due_cents, 0);
  ELSE
    RAISE EXCEPTION 'Only completed jobs or fee-bearing cancellations can be paid out. Current status: %', booking_row.status USING ERRCODE = '22000';
  END IF;

  IF booking_row.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No Easer assigned to this booking' USING ERRCODE = '22000';
  END IF;
  IF booking_row.payout_status = 'paid' THEN
    RAISE EXCEPTION 'Payout already recorded for this booking.' USING ERRCODE = '23505';
  END IF;
  IF canonical_due_cents <= 0 OR p_payout_amount_cents IS DISTINCT FROM canonical_due_cents THEN
    RAISE EXCEPTION 'Payout amount must exactly equal canonical Easer earnings of % cents', canonical_due_cents USING ERRCODE = '22000';
  END IF;
  IF COALESCE(BTRIM(p_notes), '') = '' THEN
    RAISE EXCEPTION 'A bank confirmation ID or payout reference is required' USING ERRCODE = '22000';
  END IF;
  IF LOWER(COALESCE(p_payout_method, 'manual')) = 'stripe_connect' THEN
    RAISE EXCEPTION 'Stripe Connect transfers must be reconciled by Stripe state, not recorded as manual payouts' USING ERRCODE = '22000';
  END IF;

  amount_charged_cents := COALESCE(booking_row.amount_charged, 0);
  net_captured_cents := GREATEST(0, amount_charged_cents - COALESCE(booking_row.refund_amount, 0));
  remaining_tax_cents := CASE
    WHEN booking_row.status = 'cancelled' OR amount_charged_cents <= 0 THEN 0
    ELSE ROUND(COALESCE(booking_row.tax_amount, 0)::NUMERIC * net_captured_cents / amount_charged_cents)::INTEGER
  END;
  stripe_fee_cents := COALESCE(
    booking_row.stripe_fee,
    CASE WHEN net_captured_cents > 0 THEN ROUND(net_captured_cents * 0.029)::INTEGER + 30 ELSE 0 END
  );
  platform_revenue_cents := net_captured_cents - remaining_tax_cents - stripe_fee_cents - canonical_due_cents;

  UPDATE bookings SET
    payout_amount = canonical_due_cents,
    paid_out_at = NOW(),
    payout_notes = BTRIM(p_notes),
    payout_status = 'paid',
    platform_revenue = platform_revenue_cents,
    cancellation_easer_payout_status = CASE WHEN booking_row.status = 'cancelled' THEN 'paid' ELSE booking_row.cancellation_easer_payout_status END
  WHERE id = booking_row.id;

  INSERT INTO payout_ledger (
    booking_id, booking_ref, assembler_id, assembler_name, assembler_tier,
    service, booking_date, amount_charged, assembler_due, payout_amount,
    platform_revenue, payout_notes, recorded_by, payout_method
  ) VALUES (
    booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, booking_row.service,
    booking_row.date::text, amount_charged_cents, canonical_due_cents,
    canonical_due_cents, platform_revenue_cents, BTRIM(p_notes),
    COALESCE(p_recorded_by, 'owner'), LOWER(COALESCE(p_payout_method, 'manual'))
  );

  RETURN QUERY SELECT booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, canonical_due_cents,
    platform_revenue_cents, amount_charged_cents, canonical_due_cents, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;
