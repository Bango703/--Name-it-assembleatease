-- Where an Easer applicant came from.
--
-- WHY. 54 city recruitment pages are live and indexed, and nothing recorded
-- which of them produced an application. The only location on a profile is
-- the city the applicant typed, which answers "where do they live" — not
-- "which page brought them". Those look the same in a report and lead to
-- opposite decisions: one says where to recruit, the other says which page
-- is working.
--
-- Bookings have carried this since migration 056 (bookings.booking_attribution).
-- Applications get the same shape, sanitised by the same function
-- (api/_attribution.js), so the two funnels stay comparable.
--
-- Bounded and privacy-safe by construction: the browser sends only UTM
-- parameters, a click id, the landing PATH, and the referrer HOSTNAME — never
-- a full referrer URL, which can carry a query string that identifies someone.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS application_attribution JSONB NOT NULL DEFAULT '{}'::JSONB;

COMMENT ON COLUMN public.profiles.application_attribution IS
  'Acquisition attribution captured on the page the applicant arrived on, usually a city '
  'recruitment page rather than the form. Same shape as bookings.booking_attribution. '
  'Empty object means captured before this column existed, or capture was unavailable.';

-- A JSONB column that can hold a scalar or an array breaks every ->> read
-- that follows. Same guard migration 056 put on bookings.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.profiles'::regclass
       AND conname = 'profiles_attribution_object'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_attribution_object
      CHECK (jsonb_typeof(application_attribution) = 'object');
  END IF;
END $$;

-- The two questions the owner will actually ask: which channel, and which
-- page. Partial, so rows captured before this existed cost nothing.
CREATE INDEX IF NOT EXISTS idx_profiles_attribution_source
  ON public.profiles ((lower(application_attribution ->> 'source')))
  WHERE application_attribution <> '{}'::JSONB;

CREATE INDEX IF NOT EXISTS idx_profiles_attribution_landing
  ON public.profiles ((application_attribution ->> 'landingPath'))
  WHERE application_attribution <> '{}'::JSONB;

-- PostgREST caches the schema. Without this the column exists in Postgres and
-- the API cannot see it, so every write silently drops the value. Migration
-- 068 cost twelve hours this way.
NOTIFY pgrst, 'reload schema';
