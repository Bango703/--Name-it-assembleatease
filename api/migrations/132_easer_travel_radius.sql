-- ============================================================
-- Migration 132: how far each Easer travels for a job
--
-- Owner, 2026-11-21: "why are offers being sent to locations thats 200 miles
-- away?" and "everyone should be in a located area". Dispatch now offers a job
-- only to Easers whose home ZIP is within their travel distance of the job
-- (serviceAreaCheck in api/_source-of-truth.js). This column is the distance
-- the Easer chose on their profile: 15, 25, 50 or 75 miles.
--
-- NULL means the platform default (TRAVEL_RADIUS_MILES.default, 50 miles), so
-- nothing changes for an Easer until they choose. Written only by
-- api/assembler/work-preferences.js with the service role. Dispatch and the
-- coverage check read it with their own query (loadTravelRadii in
-- api/_easer-work-preferences.js) and run on the default before this is applied.
-- The CHECK is a wide safety bound; the allowed choices live in code.
-- ============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS travel_radius_miles SMALLINT;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_travel_radius_miles_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_travel_radius_miles_check
  CHECK (travel_radius_miles IS NULL OR travel_radius_miles BETWEEN 5 AND 100);

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (132, 'easer_travel_radius')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';
