-- ============================================================
-- Migration 028: Atomic AssembleCash redemption
-- Prevents two overlapping checkouts from spending the same rewards balance.
-- We serialize by normalized customer email with an advisory xact lock, then
-- re-check available balance and insert the redeem row inside one DB function.
-- ============================================================

CREATE OR REPLACE FUNCTION assemblecash_try_redeem(
  p_email TEXT,
  p_amount_cents INTEGER,
  p_booking_ref TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_email TEXT := LOWER(TRIM(COALESCE(p_email, '')));
  v_amount INTEGER := GREATEST(0, COALESCE(p_amount_cents, 0));
  v_available INTEGER := 0;
BEGIN
  IF v_email = '' OR v_amount <= 0 THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 28025));

  SELECT GREATEST(0,
    COALESCE(SUM(amount_earned_cents) FILTER (
      WHERE status = 'available' AND (expires_at IS NULL OR expires_at > NOW())
    ), 0)
    - COALESCE(SUM(amount_redeemed_cents) FILTER (WHERE status = 'redeemed'), 0)
  )::INTEGER
  INTO v_available
  FROM assemblecash_ledger
  WHERE customer_email = v_email;

  IF v_available < v_amount THEN
    RETURN 0;
  END IF;

  INSERT INTO assemblecash_ledger (
    customer_email,
    booking_ref,
    amount_redeemed_cents,
    status,
    reason
  ) VALUES (
    v_email,
    NULLIF(TRIM(COALESCE(p_booking_ref, '')), ''),
    v_amount,
    'redeemed',
    'redeem:booking_pending'
  );

  RETURN v_amount;
END;
$$;
