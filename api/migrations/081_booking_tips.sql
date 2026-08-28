-- ============================================================
-- Migration 081: booking_tips — customer tips paid directly to the Easer
--
-- WHOSE MONEY THIS IS
-- A tip is charged DIRECTLY on the Easer's own connected account, not on the
-- platform. It is never platform revenue, never enters the payout ledger, and
-- never appears in platform financial reporting. This table records that a tip
-- happened so the owner and the Easer can both see it — it is a receipt, not a
-- ledger of money the platform holds.
--
-- That distinction is deliberate and load-bearing:
--   * the platform takes no cut, and there is nowhere in this schema to put one
--   * tips are the Easer's income on their OWN Stripe account, so they do not
--     enter the platform's 1099-NEC calculation for that Easer
--   * a disputed tip charges back against the EASER's account, which is why the
--     contractor agreement has to say so
--
-- NO PLATFORM FEE COLUMN EXISTS ON PURPose. Adding one later should require
-- deliberately altering this table and re-reading this comment.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.booking_tips (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            UUID        NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  easer_id              UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,

  -- What the CUSTOMER chose to give. This is the number they saw and agreed to;
  -- the processing fee is between Stripe and the Easer and is never shown to them.
  amount_cents          INTEGER     NOT NULL CHECK (amount_cents > 0),

  -- Stripe's actual fee and the Easer's actual net, filled from the balance
  -- transaction. Nullable because the charge succeeds before the fee is known.
  stripe_fee_cents      INTEGER,
  easer_net_cents       INTEGER,

  -- The charge lives on the EASER's account, so both ids are recorded: without
  -- the account id a payment intent id alone cannot be looked up.
  stripe_account_id     TEXT        NOT NULL,
  stripe_payment_intent_id TEXT     NOT NULL,

  status                TEXT        NOT NULL DEFAULT 'succeeded'
                          CHECK (status IN ('succeeded', 'refunded', 'disputed', 'failed')),
  refunded_cents        INTEGER     NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),

  customer_email        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One tip per booking. A second thank-you is a lovely idea and a terrible
-- accident: a double-tapped button must not charge twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_tips_one_per_booking
  ON public.booking_tips (booking_id)
  WHERE status <> 'failed';

-- Stripe is truth; this must be findable from a webhook that only knows the intent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_tips_intent
  ON public.booking_tips (stripe_payment_intent_id);

CREATE INDEX IF NOT EXISTS idx_booking_tips_easer
  ON public.booking_tips (easer_id, created_at DESC);

-- A refund can never exceed the tip.
ALTER TABLE public.booking_tips
  DROP CONSTRAINT IF EXISTS booking_tips_refund_within_amount_check;
ALTER TABLE public.booking_tips
  ADD CONSTRAINT booking_tips_refund_within_amount_check
  CHECK (refunded_cents <= amount_cents);

ALTER TABLE public.booking_tips ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'booking_tips' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON public.booking_tips
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END;
$do$;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (81, '081_booking_tips')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT to_regclass('public.booking_tips') AS tips_table;
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'booking_tips'
   AND column_name IN ('amount_cents','stripe_account_id','easer_net_cents','refunded_cents')
 ORDER BY 1;
-- Expected: the table name, and 4 column rows.
