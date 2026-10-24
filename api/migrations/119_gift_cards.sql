-- ============================================================
-- Migration 119: gift cards and the Move-In Pass
--
-- Owner, 2026-10-24. One stored-value system, two products:
--   gift_card     someone buys $25-$500 of credit for a recipient
--   move_in_pass  $49 paid, $11 promotional bonus, priority for 30 days
--
-- Money rules (federal CARD Act): value a customer PAID for does not expire
-- (paid_cents never expires here). Only a clearly disclosed promotional bonus
-- may expire (bonus_cents, bonus_expires_at). Bonus is spent before paid value.
--
-- A gift card is a way to pay, not a discount: tax applies to the full
-- service price at the time of use, and the Easer's pay is unchanged.
--
-- Balances are never stored; they are the sum of gift_card_ledger. Every
-- issue, use and return is a row. Redemption is atomic per card.
-- Safe to re-run.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.gift_cards (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash                   TEXT NOT NULL UNIQUE,
  code_last4                  TEXT NOT NULL CHECK (code_last4 ~ '^[A-Z0-9]{4}$'),
  kind                        TEXT NOT NULL CHECK (kind IN ('gift_card', 'move_in_pass')),
  paid_cents                  INTEGER NOT NULL CHECK (paid_cents BETWEEN 100 AND 100000),
  bonus_cents                 INTEGER NOT NULL DEFAULT 0 CHECK (bonus_cents BETWEEN 0 AND 10000),
  bonus_expires_at            TIMESTAMPTZ,
  priority_until              TIMESTAMPTZ,
  purchaser_email             TEXT NOT NULL,
  purchaser_name              TEXT,
  recipient_email             TEXT NOT NULL,
  recipient_name              TEXT,
  message                     TEXT CHECK (message IS NULL OR char_length(message) <= 400),
  stripe_checkout_session_id  TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id    TEXT,
  status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  delivery_claimed_at         TIMESTAMPTZ,
  delivered_at                TIMESTAMPTZ,
  delivery_error              TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gift_cards_bonus_expiry CHECK (bonus_cents = 0 OR bonus_expires_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS gift_cards_recipient_idx ON public.gift_cards (LOWER(recipient_email));
CREATE INDEX IF NOT EXISTS gift_cards_created_idx ON public.gift_cards (created_at DESC);

CREATE TABLE IF NOT EXISTS public.gift_card_ledger (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id       UUID NOT NULL REFERENCES public.gift_cards(id) ON DELETE RESTRICT,
  entry_type         TEXT NOT NULL CHECK (entry_type IN ('issue', 'redeem', 'release', 'void')),
  paid_delta_cents   INTEGER NOT NULL DEFAULT 0,
  bonus_delta_cents  INTEGER NOT NULL DEFAULT 0,
  booking_ref        TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gift_card_ledger_card_idx ON public.gift_card_ledger (gift_card_id, created_at);
CREATE INDEX IF NOT EXISTS gift_card_ledger_booking_idx ON public.gift_card_ledger (booking_ref);
-- One issue row per card, so a retried issue can never double the value.
CREATE UNIQUE INDEX IF NOT EXISTS gift_card_ledger_one_issue
  ON public.gift_card_ledger (gift_card_id) WHERE entry_type = 'issue';

ALTER TABLE public.gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gift_card_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gift_cards_service_role_all ON public.gift_cards;
CREATE POLICY gift_cards_service_role_all ON public.gift_cards
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS gift_card_ledger_service_role_all ON public.gift_card_ledger;
CREATE POLICY gift_card_ledger_service_role_all ON public.gift_card_ledger
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.gift_cards FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.gift_card_ledger FROM PUBLIC, anon, authenticated;

-- Remaining value on every card. The ONE balance rule: paid value never
-- expires; bonus value counts only until bonus_expires_at; a void card is 0.
CREATE OR REPLACE FUNCTION public.gift_card_balances_v1()
RETURNS TABLE (gift_card_id UUID, paid_cents INTEGER, bonus_cents INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    gc.id,
    CASE WHEN gc.status <> 'active' THEN 0
         ELSE GREATEST(0, COALESCE(SUM(l.paid_delta_cents), 0))::INTEGER END,
    CASE WHEN gc.status <> 'active' THEN 0
         WHEN gc.bonus_expires_at IS NOT NULL AND gc.bonus_expires_at <= NOW() THEN 0
         ELSE GREATEST(0, COALESCE(SUM(l.bonus_delta_cents), 0))::INTEGER END
  FROM public.gift_cards gc
  LEFT JOIN public.gift_card_ledger l ON l.gift_card_id = gc.id
  GROUP BY gc.id, gc.status, gc.bonus_expires_at;
$$;

CREATE OR REPLACE FUNCTION public.gift_card_balance_v1(p_gift_card_id UUID)
RETURNS TABLE (paid_cents INTEGER, bonus_cents INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.paid_cents, b.bonus_cents FROM public.gift_card_balances_v1() b WHERE b.gift_card_id = p_gift_card_id;
$$;

-- Use up to p_amount_cents from one card for one booking. Bonus first, then
-- paid value. Returns what was taken; a repeat call for the same booking
-- returns the existing use instead of taking more.
CREATE OR REPLACE FUNCTION public.gift_card_redeem_v1(p_code_hash TEXT, p_amount_cents INTEGER, p_booking_ref TEXT)
RETURNS TABLE (gift_card_id UUID, paid_used INTEGER, bonus_used INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_card public.gift_cards%ROWTYPE;
  v_paid INTEGER;
  v_bonus INTEGER;
  v_want INTEGER := GREATEST(0, COALESCE(p_amount_cents, 0));
  v_bonus_take INTEGER;
  v_paid_take INTEGER;
  v_existing RECORD;
BEGIN
  IF p_booking_ref IS NULL OR p_booking_ref = '' OR v_want = 0 THEN
    RETURN;
  END IF;
  SELECT * INTO v_card FROM public.gift_cards WHERE code_hash = p_code_hash AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT -COALESCE(SUM(paid_delta_cents), 0) AS paid, -COALESCE(SUM(bonus_delta_cents), 0) AS bonus
    INTO v_existing
    FROM public.gift_card_ledger
    WHERE gift_card_ledger.gift_card_id = v_card.id AND booking_ref = p_booking_ref AND entry_type IN ('redeem', 'release');
  IF COALESCE(v_existing.paid, 0) > 0 OR COALESCE(v_existing.bonus, 0) > 0 THEN
    RETURN QUERY SELECT v_card.id, v_existing.paid::INTEGER, v_existing.bonus::INTEGER;
    RETURN;
  END IF;

  SELECT b.paid_cents, b.bonus_cents INTO v_paid, v_bonus FROM public.gift_card_balance_v1(v_card.id) b;
  v_bonus_take := LEAST(v_bonus, v_want);
  v_paid_take := LEAST(v_paid, v_want - v_bonus_take);
  IF v_bonus_take + v_paid_take = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.gift_card_ledger (gift_card_id, entry_type, paid_delta_cents, bonus_delta_cents, booking_ref, note)
  VALUES (v_card.id, 'redeem', -v_paid_take, -v_bonus_take, p_booking_ref, 'used on booking');
  RETURN QUERY SELECT v_card.id, v_paid_take, v_bonus_take;
END;
$$;

-- Give back whatever a booking took (cancellation, failed booking). Safe to repeat.
CREATE OR REPLACE FUNCTION public.gift_card_release_v1(p_booking_ref TEXT, p_note TEXT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  v_released INTEGER := 0;
BEGIN
  FOR r IN
    SELECT gift_card_id, -SUM(paid_delta_cents) AS paid, -SUM(bonus_delta_cents) AS bonus
    FROM public.gift_card_ledger
    WHERE booking_ref = p_booking_ref AND entry_type IN ('redeem', 'release')
    GROUP BY gift_card_id
  LOOP
    PERFORM 1 FROM public.gift_cards WHERE id = r.gift_card_id FOR UPDATE;
    IF r.paid > 0 OR r.bonus > 0 THEN
      INSERT INTO public.gift_card_ledger (gift_card_id, entry_type, paid_delta_cents, bonus_delta_cents, booking_ref, note)
      VALUES (r.gift_card_id, 'release', r.paid, r.bonus, p_booking_ref, COALESCE(p_note, 'returned to card'));
      v_released := v_released + r.paid + r.bonus;
    END IF;
  END LOOP;
  RETURN v_released;
END;
$$;

REVOKE ALL ON FUNCTION public.gift_card_balances_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gift_card_balance_v1(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gift_card_redeem_v1(TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gift_card_release_v1(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gift_card_balances_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.gift_card_balance_v1(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.gift_card_redeem_v1(TEXT, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.gift_card_release_v1(TEXT, TEXT) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
