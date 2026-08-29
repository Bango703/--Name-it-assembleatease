-- ============================================================
-- Migration 083: a tip is 'pending' until Stripe says otherwise
--
-- WHAT THIS FIXES
-- booking_tips rows were written with status 'succeeded' at the moment the
-- PaymentIntent was CREATED — before the customer had confirmed anything. The
-- browser then confirmed the payment and never told the server the outcome, so
-- the row said "succeeded" whether the card cleared, was declined, or the tab
-- was closed.
--
-- Combined with the missing Stripe.js library on review.html (fixed alongside
-- this), every single tip attempt would have written a succeeded row for money
-- that was never taken, while correctly telling the customer nothing was
-- charged. The database would have been the only party claiming a tip happened.
--
-- Rule 5: Stripe is financial truth. A row may claim money moved only after
-- Stripe confirms it moved.
--
-- 'pending'  the intent exists, the customer has not confirmed yet
-- 'succeeded' Stripe reported payment_intent.status === 'succeeded'
-- 'failed'   declined, cancelled, or abandoned
--
-- The DEFAULT moves to 'pending' so that a future writer that forgets to set a
-- status understates rather than overstates. Failing toward "no money moved" is
-- the only safe direction for this column.
-- ============================================================

ALTER TABLE public.booking_tips
  DROP CONSTRAINT IF EXISTS booking_tips_status_check;

ALTER TABLE public.booking_tips
  ADD CONSTRAINT booking_tips_status_check
  CHECK (status IN ('pending', 'succeeded', 'refunded', 'disputed', 'failed'));

ALTER TABLE public.booking_tips
  ALTER COLUMN status SET DEFAULT 'pending';

-- The one-tip-per-booking index still excludes only 'failed'. A 'pending' row
-- deliberately holds the slot: it stops a double-tap charging twice. The send
-- path UPDATES that row rather than inserting a second one, so a customer who
-- changes their mind about the amount is never blocked by their own earlier
-- attempt.

-- Finding a stale pending row is now a routine reconciliation question, so it
-- gets an index rather than a table scan.
CREATE INDEX IF NOT EXISTS idx_booking_tips_pending
  ON public.booking_tips (created_at)
  WHERE status = 'pending';

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (83, '083_booking_tips_pending_state')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_default FROM information_schema.columns
 WHERE table_name = 'booking_tips' AND column_name = 'status';
-- Expected: 'pending'::text

SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname = 'booking_tips_status_check';
-- Expected: CHECK (status = ANY (ARRAY['pending', 'succeeded', 'refunded', 'disputed', 'failed']))

SELECT status, COUNT(*) FROM public.booking_tips GROUP BY status;
-- Expected: no rows (nothing has been tipped yet).
