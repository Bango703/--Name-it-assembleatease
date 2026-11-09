-- ============================================================
-- Migration 127: gift card credit on a booking (was 120; renumbered 2026-11-08, 120 is taken by thumbtack_external_bookings)
--
-- Owner, 2026-10-24 (gift cards stage 2). A gift card pays part of a booking.
-- It is money already collected, not a discount: tax_amount stays the tax on
-- the full price, and the Easer's pay is figured on the full price.
--
--   total_price             what the customer's card is held for and charged
--   gift_card_applied_cents what the gift card paid (0 when none, and set back
--                           to 0 when the credit is returned to the card)
--
-- Full price = total_price + gift_card_applied_cents.
-- Safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS gift_card_applied_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gift_card_id UUID REFERENCES public.gift_cards(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS gift_card_last4 TEXT,
  ADD COLUMN IF NOT EXISTS gift_card_priority BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_gift_card_applied_nonnegative') THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_gift_card_applied_nonnegative CHECK (gift_card_applied_cents >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bookings_gift_card_idx ON public.bookings (gift_card_id) WHERE gift_card_id IS NOT NULL;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (127, 'booking_gift_card')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
