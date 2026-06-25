-- ============================================================
-- Migration 025: AssembleCash rewards ledger + customer email verification
-- AssembleCash is future-booking CREDIT (never cash, never withdrawable).
-- Identity is the normalized lowercase customer email — there is no customer
-- login. Balance view and redemption are gated by a one-time email code
-- (passwordless OTP) so a balance can never be seen or spent from a typed
-- email alone. Earning accrues only after a booking is completed AND payment
-- is captured; it reverses on refund; it expires after 180 days.
-- ============================================================

-- ---- Ledger -------------------------------------------------
CREATE TABLE IF NOT EXISTS assemblecash_ledger (
  id                    UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_email        TEXT        NOT NULL,                       -- normalized lowercase
  booking_id            UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  booking_ref           TEXT,
  amount_earned_cents   INTEGER     NOT NULL DEFAULT 0,             -- >0 on an earn row
  amount_redeemed_cents INTEGER     NOT NULL DEFAULT 0,             -- >0 on a redeem row
  status                TEXT        NOT NULL DEFAULT 'pending',     -- pending|available|redeemed|expired|reversed
  reason                TEXT,                                       -- e.g. 'earn:booking_complete', 'redeem:booking', 'reverse:refund'
  expires_at            TIMESTAMPTZ,                                -- earn rows only
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assemblecash_status_chk
    CHECK (status IN ('pending','available','redeemed','expired','reversed'))
);

-- One earn row per booking (idempotent earning — never double-credit a job).
CREATE UNIQUE INDEX IF NOT EXISTS idx_assemblecash_earn_booking_unique
  ON assemblecash_ledger(booking_id)
  WHERE amount_earned_cents > 0;

CREATE INDEX IF NOT EXISTS idx_assemblecash_email_status
  ON assemblecash_ledger(customer_email, status);
CREATE INDEX IF NOT EXISTS idx_assemblecash_expires
  ON assemblecash_ledger(expires_at)
  WHERE status = 'available';

ALTER TABLE assemblecash_ledger ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'assemblecash_ledger' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON assemblecash_ledger
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ---- Passwordless email codes (OTP) -------------------------
CREATE TABLE IF NOT EXISTS customer_verification_codes (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  email        TEXT        NOT NULL,                                -- normalized lowercase
  code_hash    TEXT        NOT NULL,                                -- SHA-256 of the 6-digit code (never store plaintext)
  purpose      TEXT        NOT NULL DEFAULT 'assemblecash',
  attempts     INTEGER     NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cust_codes_email_purpose
  ON customer_verification_codes(email, purpose, created_at DESC);

ALTER TABLE customer_verification_codes ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'customer_verification_codes' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON customer_verification_codes
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ---- Available balance (atomic, server-computed) ------------
-- Balance = available, non-expired earned credit minus all redemptions.
-- Pending and reversed earn rows do NOT count. The API still re-checks the
-- per-booking cap and the platform margin floor before applying any credit.
CREATE OR REPLACE FUNCTION assemblecash_available_balance(p_email TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(0,
    COALESCE(SUM(amount_earned_cents) FILTER (
      WHERE status = 'available' AND (expires_at IS NULL OR expires_at > NOW())
    ), 0)
    - COALESCE(SUM(amount_redeemed_cents) FILTER (WHERE status = 'redeemed'), 0)
  )::INTEGER
  FROM assemblecash_ledger
  WHERE customer_email = LOWER(TRIM(p_email));
$$;

-- Atomic redemption reservation for checkout. Migration 028 repeats this for
-- already-provisioned databases; keeping it here makes a fresh database complete.
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
