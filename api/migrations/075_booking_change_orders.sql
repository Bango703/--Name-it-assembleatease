-- ============================================================
-- Migration 075: Change orders — additional scope priced on a LIVE booking
--
-- THE PROBLEM: once a booking was authorized, its price was frozen.
-- api/owner/edit-booking.js refuses direct price edits (correctly — Rule 9, the
-- customer must never be surprised by a charge), and quote approval only works
-- on a pending booking. So when an Easer arrived and found work that was not on
-- the order — a wall that needs anchoring, a floor that needs levelling, an
-- extra item — there was nowhere for that money to go. The business ate it, or
-- the owner collected off-platform where nothing is tracked, taxed, or paid out.
--
-- A change order is additional scope, approved by the customer, authorized on
-- their saved card, and captured with the job.
--
-- WHY A SEPARATE PAYMENT INTENT, NOT A BIGGER ONE:
-- The completion capture in api/booking/_stripe-booking-payment.js validates
-- `intent.amount === booking.total_price` before it will capture. Raising
-- total_price would make every existing authorization fail that check — the most
-- dangerous possible regression, on the one path that moves customer money.
-- Incremental authorization is also not reliably available on card payments.
-- So bookings.total_price stays the ORIGINAL authorized amount forever, each
-- change order carries its own manual-capture PaymentIntent, and completion
-- captures the original plus every approved change order.
--
-- INVARIANTS (Constitution Article 6):
--   - No charge without recorded customer approval. approved_at and the
--     approval token hash are required before a PaymentIntent may exist.
--   - One PaymentIntent per change order, unique, never reused.
--   - Amounts are server-calculated; the browser never supplies a total.
--   - Terminal states are final: captured, refunded, voided, declined.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.booking_change_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id              UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,

  -- What the customer is being asked to pay for, in their words.
  description             TEXT NOT NULL,
  -- Optional link to the catalog item that prompted it.
  item_name               TEXT,

  -- Server-calculated money. subtotal + tax = total. Nothing else is authoritative.
  subtotal_cents          INTEGER NOT NULL,
  tax_cents               INTEGER NOT NULL,
  total_cents             INTEGER NOT NULL,

  status                  TEXT NOT NULL DEFAULT 'pending_customer_approval',

  -- Customer approval, one-time token (hashed, never stored raw).
  approval_token_hash     TEXT,
  approval_expires_at     TIMESTAMPTZ,
  approved_at             TIMESTAMPTZ,
  declined_at             TIMESTAMPTZ,
  decline_reason          TEXT,

  -- Its own authorization. Never the booking's.
  stripe_payment_intent_id TEXT,
  authorized_at           TIMESTAMPTZ,
  captured_at             TIMESTAMPTZ,
  captured_amount_cents   INTEGER,
  stripe_fee_cents        INTEGER,
  refunded_cents          INTEGER NOT NULL DEFAULT 0,

  -- Who raised it, and which Easer's work it covers (for the payout split).
  created_by              TEXT NOT NULL DEFAULT 'owner',
  requested_by_easer_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  booking_status_at_creation TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT booking_change_orders_status_check CHECK (
    status IN ('pending_customer_approval', 'authorized', 'captured', 'declined', 'voided', 'refunded')
  ),
  CONSTRAINT booking_change_orders_money_check CHECK (
    subtotal_cents > 0
    AND tax_cents >= 0
    AND total_cents = subtotal_cents + tax_cents
    AND refunded_cents >= 0
    AND refunded_cents <= total_cents
  ),
  -- A charge cannot exist without the customer having said yes.
  CONSTRAINT booking_change_orders_approval_before_charge_check CHECK (
    stripe_payment_intent_id IS NULL OR approved_at IS NOT NULL
  ),
  -- Captured means captured: an amount and a time, both present.
  CONSTRAINT booking_change_orders_capture_truth_check CHECK (
    (status <> 'captured')
    OR (captured_at IS NOT NULL AND captured_amount_cents IS NOT NULL AND stripe_payment_intent_id IS NOT NULL)
  ),
  CONSTRAINT booking_change_orders_description_check CHECK (
    length(btrim(description)) BETWEEN 3 AND 500
  )
);

CREATE INDEX IF NOT EXISTS idx_change_orders_booking
  ON public.booking_change_orders (booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_change_orders_open
  ON public.booking_change_orders (status)
  WHERE status IN ('pending_customer_approval', 'authorized');

-- One PaymentIntent belongs to exactly one change order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_orders_payment_intent_unique
  ON public.booking_change_orders (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- A live approval token is single-use and unguessable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_orders_approval_token_unique
  ON public.booking_change_orders (approval_token_hash)
  WHERE approval_token_hash IS NOT NULL;

ALTER TABLE public.booking_change_orders ENABLE ROW LEVEL SECURITY;
-- Service-role API routes only. No browser reaches this table directly; the
-- customer sees a change order through a signed approval link, the Easer sees
-- only the scope, and the owner sees it through the owner API.
REVOKE ALL ON TABLE public.booking_change_orders FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_change_orders TO service_role;

DO $$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (75, '075_booking_change_orders')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$$;
