-- Authorization capture deadline
--
-- THE INCIDENT. Booking AAE-DVSNHXE4OO was taken on 2026-09-19 for a 2026-09-24
-- appointment and authorized immediately, because IMMEDIATE_AUTHORIZATION_DAYS
-- is 6 and the job was 5 days out. That rule assumes a card authorization lasts
-- 7 days. A Visa merchant-initiated authorization is valid for 4 days and 18
-- hours, so the hold died on 2026-09-23 — the day before the Easer arrived. The
-- failure surfaced at capture, when the job was already done.
--
-- Stripe knows the real answer per charge and always has:
-- charge.payment_method_details.card.capture_before. It accounts for the card
-- brand and for whether the transaction was merchant- or customer-initiated,
-- neither of which we can infer. Nothing in this codebase read it.
--
-- A constant would be wrong for Visa MIT today and wrong again the next time a
-- network changes a window. So the deadline is stored as Stripe reports it, at
-- the moment the authorization succeeds, and every readiness decision reads
-- this column instead of counting days.
--
-- NULL means unknown, never "fine". A booking authorized before this column
-- existed has no deadline recorded; callers must treat that as unverified
-- rather than assume there is time left.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS authorization_capture_before TIMESTAMPTZ;

COMMENT ON COLUMN public.bookings.authorization_capture_before IS
  'When the current card authorization stops being capturable, as reported by Stripe '
  '(charge.payment_method_details.card.capture_before). NULL means not recorded, which '
  'is unverified rather than safe. Cleared whenever the authorization is replaced.';

-- The monitor asks one question every run: which live authorizations are close
-- to expiring? Only rows that have a deadline are of interest.
CREATE INDEX IF NOT EXISTS idx_bookings_authorization_capture_before
  ON public.bookings (authorization_capture_before)
  WHERE authorization_capture_before IS NOT NULL;

-- PostgREST caches the schema. Without this the column exists in Postgres and
-- the API cannot see it, so every write above silently drops the value until
-- something else reloads the cache. Migration 068 cost twelve hours this way.
NOTIFY pgrst, 'reload schema';
