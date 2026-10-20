-- ============================================================
-- Migration 118: real job photos on the public website
--
-- Owner, 2026-10-20: completion photos are also the company's real photos for
-- the website. Terms version 2026-10-20 (section 8) lets AssembleAtEase show
-- photos of completed work with identifying details left out, and lets a
-- customer opt out. Bookings under earlier Terms are never used.
--
--   1. the owner saves a photo to the collection after a privacy check (no
--      people, house numbers, mail, documents): website_collected_at;
--   2. the owner posts a collected photo to a service page when ready:
--      website_published_at, with a copy in the public job-photos bucket,
--      which the service and city pages read. Taking it down deletes the copy;
--   3. a customer who opts out: bookings.website_photo_opt_out_at, and
--      their photos leave the collection and the website.
--
-- The private booking-evidence bucket is never made public.
-- Safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS website_photo_opt_out_at TIMESTAMPTZ;

ALTER TABLE public.booking_evidence
  ADD COLUMN IF NOT EXISTS website_collected_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS website_published_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS website_published_by  TEXT,
  ADD COLUMN IF NOT EXISTS website_service       TEXT,
  ADD COLUMN IF NOT EXISTS website_city_slug     TEXT,
  ADD COLUMN IF NOT EXISTS website_alt           TEXT,
  ADD COLUMN IF NOT EXISTS website_public_path   TEXT;

ALTER TABLE public.booking_evidence
  DROP CONSTRAINT IF EXISTS booking_evidence_website_service_valid;
ALTER TABLE public.booking_evidence
  ADD CONSTRAINT booking_evidence_website_service_valid CHECK (
    website_service IS NULL OR website_service IN (
      'furniture-assembly', 'tv-mounting', 'smart-home-installation',
      'fitness-equipment-assembly', 'office-furniture-assembly', 'playset-assembly'
    )
  );

-- A published photo is in the collection and says what it shows and where it lives.
ALTER TABLE public.booking_evidence
  DROP CONSTRAINT IF EXISTS booking_evidence_website_published_complete;
ALTER TABLE public.booking_evidence
  ADD CONSTRAINT booking_evidence_website_published_complete CHECK (
    website_published_at IS NULL
    OR (website_collected_at IS NOT NULL
        AND website_service IS NOT NULL
        AND website_public_path IS NOT NULL
        AND website_alt IS NOT NULL AND length(btrim(website_alt)) >= 10)
  );

CREATE INDEX IF NOT EXISTS idx_booking_evidence_website_collected
  ON public.booking_evidence (website_collected_at DESC)
  WHERE website_collected_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_booking_evidence_website_published
  ON public.booking_evidence (website_service, website_city_slug, website_published_at DESC)
  WHERE website_published_at IS NOT NULL;

-- Public bucket for the published copies only. Read is public; writes go
-- through the service role in api/owner/website-photo.js.
INSERT INTO storage.buckets (id, name, public)
VALUES ('job-photos', 'job-photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (118, '118_website_job_photos')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- -- Verify -----------------------------------------------------------------
SELECT table_name, column_name FROM information_schema.columns
 WHERE (table_name = 'bookings' AND column_name LIKE 'website_photo%')
    OR (table_name = 'booking_evidence' AND column_name LIKE 'website_%')
 ORDER BY 1, 2;
-- Expected: 8 rows (1 on bookings, 7 on booking_evidence).
SELECT id, public FROM storage.buckets WHERE id = 'job-photos';
-- Expected: job-photos | true
