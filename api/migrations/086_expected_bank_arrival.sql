-- ============================================================
-- Migration 086: when the Easer's money should actually land
--
-- WHAT THIS FIXES
-- An Easer could see that a transfer happened but never when the money would
-- reach their bank. The payout email said "about 2 business days", which is a
-- duration, not an answer — a pro planning around money needs a DATE, and
-- working it out from a delay figure is our job rather than theirs. The
-- dashboard showed only past timestamps: when it was paid out, when the
-- transfer was created. Nothing looked forward.
--
-- WHY IT IS STORED RATHER THAN COMPUTED ON READ
-- The figure depends on that Easer's own Stripe payout schedule at the moment
-- of transfer, which is read from their connected account. Recomputing it later
-- would need a Stripe call on every dashboard load, and would silently change
-- the answer if the schedule ever changed. Storing it captures what the Easer
-- was actually told.
--
-- IT IS AN ESTIMATE AND MUST ALWAYS READ AS ONE. The real arrival date only
-- exists once Stripe creates the bank payout, which happens after the transfer.
-- A pro told Tuesday and paid Thursday trusts the next number less, so every
-- surface says "expect it by" rather than stating it as fact.
--
-- Nullable on purpose: when the schedule cannot be read, the surfaces fall back
-- to non-specific wording instead of inventing a day.
-- ============================================================

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS expected_bank_arrival_at TIMESTAMPTZ;

COMMENT ON COLUMN public.bookings.expected_bank_arrival_at IS
  'Estimated date the Stripe bank payout reaches the Easer, computed at transfer time from that Easer''s own payout schedule. An estimate, never a promise.';

-- Answering "what is landing soon" without scanning every booking.
CREATE INDEX IF NOT EXISTS idx_bookings_expected_arrival
  ON public.bookings (expected_bank_arrival_at)
  WHERE expected_bank_arrival_at IS NOT NULL;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (86, '086_expected_bank_arrival')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'bookings' AND column_name = 'expected_bank_arrival_at';
-- Expected: one row, timestamp with time zone, YES.
