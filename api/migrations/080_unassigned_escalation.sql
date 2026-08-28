-- ============================================================
-- Migration 080: unassigned-booking escalation
--
-- WHAT THIS PREVENTS
-- AAE-LYTX3WIQW3 was booked the previous evening for a 12:00–2:00 PM window. It
-- was assigned three times and accepted by nobody. At 17:50 UTC it was flagged
-- manual_required — still with no pro. At 18:36 UTC, twenty-three minutes before
-- her window closed, the CUSTOMER cancelled it herself, and was charged $32.94.
--
-- The owner was alerted four separate times. The customer was told nothing.
-- She waited for a pro who was never coming and then paid to leave.
--
-- The fee is already made impossible by the invariant in computeCancellationFee
-- (no accepted Easer, no fee). These columns close the other half: the customer
-- must be TOLD, automatically, before their window arrives.
--
-- Two stages, tracked separately because they are different promises:
--   sourcing_escalated_at — the owner is told to source urgently
--   customer_notified_at  — the CUSTOMER is told we have not confirmed a pro,
--                           and offered a free reschedule or cancellation
--
-- One row per stage per booking. A customer who is already worrying does not
-- need the same apology every fifteen minutes.
-- ============================================================

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS unassigned_escalated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unassigned_customer_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unassigned_escalation_stage    TEXT
    CHECK (unassigned_escalation_stage IS NULL
           OR unassigned_escalation_stage IN ('sourcing', 'customer_notified', 'resolved'));

-- The customer can only have been notified after the owner was escalated to.
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_escalation_order_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_escalation_order_check
  CHECK (
    unassigned_customer_notified_at IS NULL
    OR unassigned_escalated_at IS NULL
    OR unassigned_customer_notified_at >= unassigned_escalated_at
  );

-- What the escalation cron scans: a live booking with nobody committed to it.
CREATE INDEX IF NOT EXISTS idx_bookings_unaccepted_upcoming
  ON public.bookings (date)
  WHERE status = 'confirmed' AND assembler_accepted_at IS NULL;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (80, '080_unassigned_escalation')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'bookings'
   AND column_name IN ('unassigned_escalated_at','unassigned_customer_notified_at','unassigned_escalation_stage')
 ORDER BY 1;
-- Expected: 3 rows.
