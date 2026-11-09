-- Migration 126: protect the customer after a confirmed Easer no-show.
--
-- Owner, 2026-11-08 (backlog EASER-NO-SHOW-CUSTOMER-PATH, P0): when an Easer
-- does not come, the customer must never pay or do extra work for it (Rule 9,
-- Rule 16). api/owner/confirm-no-show.js stamps this column; the cancellation
-- fee rule, the reschedule limit and the customer's status read it
-- (api/booking/_easer-no-show.js).
--
-- Run BEFORE deploying the code that reads it: the customer app's booking list
-- and push payload select this column by name.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS easer_no_show_confirmed_at TIMESTAMPTZ;

-- Backfill: no-shows the owner already confirmed (activity_logs rows written by
-- confirm-no-show, kind 'no_show'), dated from that confirmation, so a
-- replacement pro who accepted afterwards still reads as confirmed.
UPDATE public.bookings b
SET easer_no_show_confirmed_at = a.confirmed_at
FROM (
  SELECT booking_id, MIN(created_at) AS confirmed_at
  FROM public.activity_logs
  WHERE event_type = 'easer_cancelled' AND metadata->>'kind' = 'no_show'
  GROUP BY booking_id
) a
WHERE b.id = a.booking_id AND b.easer_no_show_confirmed_at IS NULL;

COMMENT ON COLUMN public.bookings.easer_no_show_confirmed_at IS
  'When the owner confirmed the assigned Easer did not show. Waives the customer cancellation fee and the reschedule limit for this booking.';

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (126, 'easer_no_show_customer_protection')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT ref, easer_no_show_confirmed_at FROM bookings
--   WHERE easer_no_show_confirmed_at IS NOT NULL ORDER BY easer_no_show_confirmed_at DESC;
-- Expected: one row per booking with an owner-confirmed Easer no-show.
