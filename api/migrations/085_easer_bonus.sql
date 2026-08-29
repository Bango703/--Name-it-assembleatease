-- ============================================================
-- Migration 085: owner-funded bonus pay for an Easer
--
-- WHAT THIS IS FOR
-- A job turned out harder than it priced. An Easer went back to finish something
-- that was not their fault. Someone did outstanding work and the owner wants to
-- say so with money. Until now there was no way to pay an Easer a cent more than
-- the split produced, so the only options were to overpay off-platform (invisible
-- to every report) or not at all.
--
-- WHERE THE MONEY COMES FROM
-- The PLATFORM. A bonus is added after the customer has already paid, so it can
-- only come out of margin — the customer is never re-charged for a decision the
-- owner made after the fact. Customer-funded scope growth is a different thing
-- entirely and belongs on the change-order path, which requires the customer to
-- authorise it.
--
-- WHY IT IS NOT PART OF THE SPLIT
-- computeBookingSplit is THE canonical answer to "how does this job's money
-- divide", and it must stay a pure function of what the customer paid. A bonus
-- is an additive layer on top, exactly like the same-day rush bonus: excluded
-- from the split base, added back at payout. Feeding it into the split would
-- make the platform fee look wrong on every report and would corrupt the one
-- number the whole platform derives earnings from.
--
-- Platform gross needs no adjustment: it is derived as
--   revenue - tax - processing - easerCost
-- and easerCost picks up the bonus through the payout amount. The margin absorbs
-- it automatically and honestly.
-- ============================================================

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS easer_bonus_cents   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS easer_bonus_reason  TEXT,
  ADD COLUMN IF NOT EXISTS easer_bonus_added_at TIMESTAMPTZ;

-- A bonus is a gift, never a deduction. Negative would be a pay cut wearing a
-- friendly name, and pay cuts must never be possible through this door.
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_easer_bonus_non_negative;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_easer_bonus_non_negative
  CHECK (easer_bonus_cents >= 0);

-- A ceiling that is generous but not a fat-finger. $500 typed as 50000 cents is
-- a bonus; 5000000 is an accident nobody catches until the bank does.
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_easer_bonus_ceiling;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_easer_bonus_ceiling
  CHECK (easer_bonus_cents <= 50000);

-- Money given without a stated reason is unauditable six months later, when the
-- only question that matters is "why did we pay this?".
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_easer_bonus_needs_reason;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_easer_bonus_needs_reason
  CHECK (
    easer_bonus_cents = 0
    OR (easer_bonus_reason IS NOT NULL AND length(btrim(easer_bonus_reason)) >= 3)
  );

CREATE INDEX IF NOT EXISTS idx_bookings_easer_bonus
  ON public.bookings (assembler_id)
  WHERE easer_bonus_cents > 0;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (85, '085_easer_bonus')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_name, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'bookings'
   AND column_name IN ('easer_bonus_cents', 'easer_bonus_reason', 'easer_bonus_added_at')
 ORDER BY 1;
-- Expected: 3 rows; easer_bonus_cents defaults to 0 and is NOT NULL.

SELECT COUNT(*) AS bookings_with_a_bonus
  FROM public.bookings WHERE easer_bonus_cents > 0;
-- Expected: 0.
