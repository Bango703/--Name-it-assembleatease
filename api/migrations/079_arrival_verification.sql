-- ============================================================
-- Migration 079: arrival verification + Easer status nudges
--
-- THE PROBLEM THIS SOLVES
-- An Easer arrives at a job and never taps "Arrived", so the owner has no idea
-- whether anyone showed up. Today nothing ever asks them: reminders go to the
-- customer, and no-show-check alerts the OWNER sixty minutes after the
-- appointment should have started. The Easer receives an assignment email and
-- then silence.
--
-- Two halves, and the order matters:
--   1. ASK. A push at the appointment time is what makes the tap happen at all.
--      Location columns are worthless if nobody ever taps.
--   2. VERIFY. When they do tap, record where they were.
--
-- WHY ARRIVAL ONLY, NOT CONTINUOUS TRACKING
-- Monitoring where an independent contractor is throughout their day is a
-- worker-classification risk: both the IRS behavioural-control test and the DOL
-- economic-reality test weigh control over the manner and means of work. A
-- single consented stamp tied to a contracted milestone verifies delivery of a
-- result; a live trail supervises a worker. These columns can only hold the
-- former — there is deliberately nowhere to put a track.
--
-- CONSENT IS REQUIRED AND RECORDED, exactly like SMS. A phone that CAN report a
-- location is not permission to record one.
-- ============================================================

-- ── Where the job is ────────────────────────────────────────────────────────
-- Geocoded once from the service address and cached, so a check costs nothing
-- at arrival time and the address can change without stale coordinates.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS service_lat        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS service_lng        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS service_geocoded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS service_geocode_source TEXT;

-- ── Where the Easer was when they said they arrived ─────────────────────────
-- accuracy_m is kept because a 2km "match" from a 3km-accurate fix proves
-- nothing, and a distance without its accuracy invites false confidence.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS arrived_lat        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS arrived_lng        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS arrived_accuracy_m INTEGER,
  ADD COLUMN IF NOT EXISTS arrived_distance_m INTEGER,
  ADD COLUMN IF NOT EXISTS arrived_location_source TEXT;

-- ── Nudge bookkeeping ───────────────────────────────────────────────────────
-- So the cron asks once per stage rather than every ten minutes forever.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS arrival_nudge_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrival_nudge_count   INTEGER NOT NULL DEFAULT 0;

-- ── Easer consent ───────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS location_consent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS location_consent_source TEXT,
  ADD COLUMN IF NOT EXISTS location_declined_at    TIMESTAMPTZ;

-- Consent and refusal cannot both stand. Re-consenting clears the refusal.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_location_consent_coherent_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_location_consent_coherent_check
  CHECK (
    location_declined_at IS NULL
    OR location_consent_at IS NULL
    OR location_declined_at >= location_consent_at
  );

-- A recorded distance is meaningless without the fix it came from.
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_arrival_location_coherent_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_arrival_location_coherent_check
  CHECK (
    arrived_distance_m IS NULL
    OR (arrived_lat IS NOT NULL AND arrived_lng IS NOT NULL)
  );

-- Jobs the nudge cron has to consider: accepted, not yet arrived.
CREATE INDEX IF NOT EXISTS idx_bookings_awaiting_arrival
  ON public.bookings (date)
  WHERE status = 'confirmed' AND checked_in_at IS NULL;

-- ── Retention ───────────────────────────────────────────────────────────────
-- Location is sensitive personal data and its usefulness expires with the job.
-- Coordinates are cleared after 90 days; the DISTANCE is kept, because "arrived
-- 18m from the address" is the audit fact worth retaining and it identifies
-- nobody once the raw fix is gone.
CREATE OR REPLACE FUNCTION public.purge_stale_arrival_coordinates()
RETURNS INTEGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  purged INTEGER;
BEGIN
  UPDATE public.bookings
     SET arrived_lat = NULL,
         arrived_lng = NULL
   WHERE checked_in_at < NOW() - INTERVAL '90 days'
     AND (arrived_lat IS NOT NULL OR arrived_lng IS NOT NULL);
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$fn$;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (79, '079_arrival_verification')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT to_regproc('public.purge_stale_arrival_coordinates') AS purge_fn;
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'bookings'
   AND column_name IN ('service_lat','arrived_lat','arrived_distance_m','arrival_nudge_count')
 ORDER BY 1;
-- Expected: purge_fn named, and 4 column rows.
