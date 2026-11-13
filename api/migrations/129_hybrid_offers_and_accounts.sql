-- ============================================================
-- Migration 129: Easer price offers on custom quotes, and partner accounts
--
-- Owner, 2026-11-12: the hybrid marketplace.
--
--   1. Private Easer price offers. On a custom quote the owner can ask the
--      Easers who cover the area what they want to earn. Each answer is
--      private. The owner picks one; the customer still gets ONE AssembleAtEase
--      quote, priced so the platform fee sits on top of the Easer's number
--      (api/booking/_quote-offers.js owns that rule).
--
--   2. Partner accounts. A partner in the pipeline (partner_leads, 104) can be
--      made an account: a private booking code that gives its account
--      discount, and preferred Easers who are offered its jobs first.
--
--   3. Preferred Easers on a booking. ONE mechanism for both: dispatch offers a
--      booking to its preferred Easers first and falls back to normal matching
--      once they have each had it (api/booking/_dispatch-internal.js).
--
-- Status and value lists are owned by api/booking/_quote-offers.js and
-- api/_partners.js; the CHECKs below list the same values
-- (scripts/test-hybrid-offers.mjs holds them equal).
--
-- Code is safe before this runs: every reader fails open on a missing table
-- or column, so quotes, bookings and dispatch behave exactly as before.
-- ============================================================

BEGIN;

-- ── 1. Easer price offers ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quote_price_offers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  easer_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'invited',
  earnings_cents  INTEGER,
  hours           NUMERIC(4,1),
  crew_size       SMALLINT,
  note            TEXT,
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  respond_by      TIMESTAMPTZ NOT NULL,
  submitted_at    TIMESTAMPTZ,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, easer_id)
);

ALTER TABLE public.quote_price_offers DROP CONSTRAINT IF EXISTS quote_price_offers_status_check;
ALTER TABLE public.quote_price_offers ADD CONSTRAINT quote_price_offers_status_check
  CHECK (status IN ('invited', 'submitted', 'withdrawn', 'selected', 'not_selected', 'closed'));

ALTER TABLE public.quote_price_offers DROP CONSTRAINT IF EXISTS quote_price_offers_earnings_check;
ALTER TABLE public.quote_price_offers ADD CONSTRAINT quote_price_offers_earnings_check
  CHECK (earnings_cents IS NULL OR earnings_cents BETWEEN 2000 AND 1500000);

ALTER TABLE public.quote_price_offers DROP CONSTRAINT IF EXISTS quote_price_offers_hours_check;
ALTER TABLE public.quote_price_offers ADD CONSTRAINT quote_price_offers_hours_check
  CHECK (hours IS NULL OR (hours >= 0.5 AND hours <= 24));

ALTER TABLE public.quote_price_offers DROP CONSTRAINT IF EXISTS quote_price_offers_crew_check;
ALTER TABLE public.quote_price_offers ADD CONSTRAINT quote_price_offers_crew_check
  CHECK (crew_size IS NULL OR crew_size BETWEEN 1 AND 4);

ALTER TABLE public.quote_price_offers DROP CONSTRAINT IF EXISTS quote_price_offers_note_check;
ALTER TABLE public.quote_price_offers ADD CONSTRAINT quote_price_offers_note_check
  CHECK (note IS NULL OR char_length(note) <= 500);

-- A submitted offer always has a price, hours and crew.
ALTER TABLE public.quote_price_offers DROP CONSTRAINT IF EXISTS quote_price_offers_submitted_complete;
ALTER TABLE public.quote_price_offers ADD CONSTRAINT quote_price_offers_submitted_complete
  CHECK (status NOT IN ('submitted', 'selected') OR (earnings_cents IS NOT NULL AND hours IS NOT NULL AND crew_size IS NOT NULL));

-- At most one selected offer per booking.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_price_offers_one_selected
  ON public.quote_price_offers (booking_id) WHERE status = 'selected';
CREATE INDEX IF NOT EXISTS idx_quote_price_offers_easer
  ON public.quote_price_offers (easer_id, status);

ALTER TABLE public.quote_price_offers ENABLE ROW LEVEL SECURITY;

-- ── 2. Partner accounts (on the pipeline row: one record per partner) ───────
ALTER TABLE public.partner_leads ADD COLUMN IF NOT EXISTS account_status TEXT;
ALTER TABLE public.partner_leads ADD COLUMN IF NOT EXISTS account_code TEXT;
ALTER TABLE public.partner_leads ADD COLUMN IF NOT EXISTS account_discount_pct NUMERIC(4,1) NOT NULL DEFAULT 0;
ALTER TABLE public.partner_leads ADD COLUMN IF NOT EXISTS account_preferred_easer_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE public.partner_leads ADD COLUMN IF NOT EXISTS account_started_at TIMESTAMPTZ;

ALTER TABLE public.partner_leads DROP CONSTRAINT IF EXISTS partner_leads_account_status_check;
ALTER TABLE public.partner_leads ADD CONSTRAINT partner_leads_account_status_check
  CHECK (account_status IS NULL OR account_status IN ('active', 'paused'));

ALTER TABLE public.partner_leads DROP CONSTRAINT IF EXISTS partner_leads_account_discount_check;
ALTER TABLE public.partner_leads ADD CONSTRAINT partner_leads_account_discount_check
  CHECK (account_discount_pct >= 0 AND account_discount_pct <= 20);

ALTER TABLE public.partner_leads DROP CONSTRAINT IF EXISTS partner_leads_account_code_format;
ALTER TABLE public.partner_leads ADD CONSTRAINT partner_leads_account_code_format
  CHECK (account_code IS NULL OR account_code ~ '^P[A-Z0-9]{7}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_leads_account_code
  ON public.partner_leads (account_code) WHERE account_code IS NOT NULL;

-- ── 3. Bookings ─────────────────────────────────────────────────────────────
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS preferred_easer_ids UUID[];
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS selected_quote_offer_id UUID REFERENCES public.quote_price_offers(id) ON DELETE SET NULL;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS quote_offers_requested_at TIMESTAMPTZ;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS commercial_partner_id UUID REFERENCES public.partner_leads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_commercial_partner
  ON public.bookings (commercial_partner_id, created_at DESC) WHERE commercial_partner_id IS NOT NULL;

-- Quote selection and Easer edits share one booking lock. No partially selected
-- offer, stale price or withdrawn offer can become a customer quote.
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS quote_offer_scope TEXT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS quote_offer_fee_pct SMALLINT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS quote_offer_earnings_cents INTEGER;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS quote_offer_crew_size SMALLINT;
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_quote_offer_snapshot_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_quote_offer_snapshot_check CHECK (
  selected_quote_offer_id IS NULL OR (
    quote_offer_fee_pct IS NOT NULL AND quote_offer_earnings_cents IS NOT NULL
    AND quote_offer_crew_size IS NOT NULL
    AND quote_offer_fee_pct IN (25, 30) AND quote_offer_earnings_cents > 0
    AND quote_offer_crew_size BETWEEN 1 AND 4
  )
);

CREATE OR REPLACE FUNCTION public.prepare_hybrid_quote(
  p_booking_id UUID, p_expected_payment_status TEXT, p_expected_token TEXT,
  p_offer_id UUID, p_expected_offer_updated_at TIMESTAMPTZ, p_quote JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b public.bookings%ROWTYPE;
  o public.quote_price_offers%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.status <> 'pending'
    OR b.payment_status IS DISTINCT FROM p_expected_payment_status
    OR b.quote_token_hash IS DISTINCT FROM p_expected_token
    OR b.quote_approved_at IS NOT NULL OR b.stripe_payment_intent_id IS NOT NULL
    OR b.financial_operation_key IS NOT NULL OR b.financial_operation_type IS NOT NULL
    OR b.financial_operation_started_at IS NOT NULL
    OR b.financial_reconciliation_required_at IS NOT NULL
    OR b.cancellation_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'Quote changed; refresh before sending' USING ERRCODE = '40001';
  END IF;
  IF NOT (b.payment_status IN ('card_saved', 'quote_pending_approval')
    OR (b.payment_status = 'not_required' AND b.payment_method_type = 'card')) THEN
    RAISE EXCEPTION 'Booking is not an open quote' USING ERRCODE = '40001';
  END IF;
  IF p_offer_id IS NOT NULL THEN
    SELECT * INTO o FROM public.quote_price_offers WHERE id = p_offer_id AND booking_id = b.id FOR UPDATE;
    IF NOT FOUND OR o.status NOT IN ('submitted', 'selected')
      OR o.updated_at IS DISTINCT FROM p_expected_offer_updated_at
      OR o.earnings_cents IS DISTINCT FROM (p_quote->>'quote_offer_earnings_cents')::INTEGER THEN
      RAISE EXCEPTION 'Easer price changed; refresh before sending' USING ERRCODE = '40001';
    END IF;
  END IF;
  IF (p_quote->>'quote_amount_cents')::INTEGER NOT BETWEEN 100 AND 2500000
    OR (p_quote->>'quote_amount_cents')::INTEGER <>
       (p_quote->>'quote_subtotal_cents')::INTEGER + (p_quote->>'quote_tax_cents')::INTEGER THEN
    RAISE EXCEPTION 'Invalid quote amount';
  END IF;
  UPDATE public.quote_price_offers SET
    status = CASE WHEN p_offer_id IS NULL THEN 'closed' ELSE 'not_selected' END,
    decided_at = now(), updated_at = now()
    WHERE booking_id = b.id AND status IN ('invited', 'submitted', 'selected')
      AND (p_offer_id IS NULL OR id <> p_offer_id);
  IF p_offer_id IS NOT NULL THEN
    UPDATE public.quote_price_offers SET status = 'selected', decided_at = now(), updated_at = now() WHERE id = p_offer_id;
  END IF;
  UPDATE public.bookings SET
    quote_amount_cents = (p_quote->>'quote_amount_cents')::INTEGER,
    quote_subtotal_cents = (p_quote->>'quote_subtotal_cents')::INTEGER,
    quote_tax_cents = (p_quote->>'quote_tax_cents')::INTEGER,
    date = (p_quote->>'date')::DATE, time = p_quote->>'time',
    quote_token_hash = p_quote->>'quote_token_hash',
    quote_sent_at = (p_quote->>'quote_sent_at')::TIMESTAMPTZ,
    quote_expires_at = (p_quote->>'quote_expires_at')::TIMESTAMPTZ,
    quote_terms_version = p_quote->>'quote_terms_version',
    quote_approval_started_at = NULL, quote_approved_at = NULL,
    payment_status = 'quote_pending_approval',
    selected_quote_offer_id = p_offer_id,
    quote_offer_fee_pct = CASE WHEN p_offer_id IS NULL THEN NULL ELSE (p_quote->>'quote_offer_fee_pct')::SMALLINT END,
    quote_offer_earnings_cents = CASE WHEN p_offer_id IS NULL THEN NULL ELSE o.earnings_cents END,
    quote_offer_crew_size = CASE WHEN p_offer_id IS NULL THEN NULL ELSE o.crew_size END,
    preferred_easer_ids = CASE WHEN p_offer_id IS NOT NULL THEN ARRAY[o.easer_id]
      WHEN b.selected_quote_offer_id IS NOT NULL THEN NULL ELSE b.preferred_easer_ids END
    WHERE id = b.id;
  RETURN b.id;
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_hybrid_quote(UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_hybrid_quote(UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.respond_quote_price_offer(
  p_offer_id UUID, p_easer_id UUID, p_action TEXT, p_value JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.bookings%ROWTYPE; o public.quote_price_offers%ROWTYPE; bid UUID;
BEGIN
  SELECT booking_id INTO bid FROM public.quote_price_offers WHERE id = p_offer_id AND easer_id = p_easer_id;
  SELECT * INTO b FROM public.bookings WHERE id = bid FOR UPDATE;
  SELECT * INTO o FROM public.quote_price_offers WHERE id = p_offer_id AND easer_id = p_easer_id FOR UPDATE;
  IF NOT FOUND OR b.status <> 'pending' OR b.selected_quote_offer_id IS NOT NULL
    OR b.quote_approved_at IS NOT NULL OR b.stripe_payment_intent_id IS NOT NULL
    OR b.financial_operation_key IS NOT NULL OR o.status NOT IN ('invited', 'submitted')
    OR o.respond_by <= now() THEN
    RAISE EXCEPTION 'Price request closed' USING ERRCODE = '40001';
  END IF;
  IF p_action = 'withdraw' THEN
    UPDATE public.quote_price_offers SET status = 'withdrawn', updated_at = now() WHERE id = o.id;
  ELSIF p_action = 'submit' THEN
    UPDATE public.quote_price_offers SET status = 'submitted',
      earnings_cents = (p_value->>'earningsCents')::INTEGER,
      hours = (p_value->>'hours')::NUMERIC, crew_size = (p_value->>'crewSize')::SMALLINT,
      note = p_value->>'note', submitted_at = now(), updated_at = now() WHERE id = o.id;
  ELSE RAISE EXCEPTION 'Unknown price request action';
  END IF;
  RETURN jsonb_build_object('id', o.id, 'firstSubmission', o.status = 'invited');
END;
$$;
REVOKE ALL ON FUNCTION public.respond_quote_price_offer(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_quote_price_offer(UUID, UUID, TEXT, JSONB) TO service_role;

-- Serialize invite batches with selection; the response window cannot be reopened
-- after a quote was selected, and concurrent invitations cannot exceed eight.
CREATE OR REPLACE FUNCTION public.guard_quote_price_invite()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE b public.bookings%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public.bookings WHERE id = NEW.booking_id FOR UPDATE;
  IF b.status <> 'pending' OR b.selected_quote_offer_id IS NOT NULL
    OR b.stripe_payment_intent_id IS NOT NULL OR b.quote_approved_at IS NOT NULL
    OR b.financial_operation_key IS NOT NULL
    OR (SELECT count(*) FROM public.quote_price_offers WHERE booking_id = b.id) >= 8 THEN
    RAISE EXCEPTION 'Price request changed or invitation limit reached' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_quote_price_invite ON public.quote_price_offers;
CREATE TRIGGER guard_quote_price_invite BEFORE INSERT ON public.quote_price_offers
FOR EACH ROW EXECUTE FUNCTION public.guard_quote_price_invite();

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (129, 'hybrid_offers_and_accounts')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
