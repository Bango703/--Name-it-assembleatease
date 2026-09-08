-- Migration 094: separate the owner's own test bookings from real demand.
--
-- On 2026-09-08 the bookings table held 14 rows. Six of them were internal:
-- four created by the owner (tg703664@gmail.com) and two by a suspended Easer
-- account (imigin20@gmail.com) while testing. Nothing distinguished them from a
-- real customer, so every count drawn from this table was wrong — 43% of the
-- booking history was staff activity, unlabelled.
--
-- That matters most in the daily and weekly summary emails, which report a
-- cancellation count. All six test rows are cancelled, so those emails have been
-- reporting fake cancellations since May. Revenue figures were never affected,
-- because a cancelled booking earns nothing.
--
-- FLAGGED, NOT DELETED. These rows carry payment intents, financial audit
-- entries and notification history. Article 6 says financial operations stay
-- auditable and Article 15 says changes stay reversible; deleting them would
-- break both to tidy a report. The flag is additive and defaults to FALSE, so
-- every existing and future row is treated as real unless someone says otherwise.
--
-- The real picture once these are excluded: 8 customer bookings, 4 completed and
-- 4 cancelled — and all four cancellations were bookings that were never
-- dispatched to anyone, which migration-adjacent work in
-- api/cron/stranded-booking-alert.js now detects.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS is_test_booking BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.bookings.is_test_booking IS
  'TRUE for internal/staff bookings that must be excluded from business metrics. Never set this on a real customer booking.';

-- Partial index: reporting queries filter for the real ones, which is the
-- overwhelming majority, so only the exceptions need indexing.
CREATE INDEX IF NOT EXISTS bookings_is_test_booking_idx
  ON public.bookings (is_test_booking)
  WHERE is_test_booking = TRUE;

-- The six known internal bookings, addressed by ref so this cannot widen if the
-- same addresses are ever used by a real customer.
UPDATE public.bookings
   SET is_test_booking = TRUE
 WHERE ref IN (
   'AAE-MRJAEH07',    -- owner, 2026-07-13
   'AAE-HUC2O0NW8E',  -- owner, 2026-08-15
   'AAE-7BP7N7A8HD',  -- owner, 2026-08-18
   'AAE-FHXM5NT1OQ',  -- owner, 2026-09-01
   'AAE-8A0NOMSRUT',  -- suspended Easer account, 2026-08-18
   'AAE-NX6TP7HQRG'   -- suspended Easer account, 2026-08-18
 );

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (94, 'mark_test_bookings')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT is_test_booking, status, COUNT(*) FROM public.bookings
--   GROUP BY 1, 2 ORDER BY 1, 2;
-- Expected: 6 test rows (all cancelled), 8 real rows (4 completed, 4 cancelled).
