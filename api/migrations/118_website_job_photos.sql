-- ============================================================
-- Migration 118: real job photos on the public website
--
-- Owner, 2026-10-20: completion photos are also the company's real photos for
-- the website. The Terms say job evidence "will not be used in public
-- marketing without separate permission", so:
--
--   1. the customer gives that permission (an unchecked box on the review
--      page): bookings.website_photo_consent_at;
--   2. the owner chooses each photo, after a privacy check (no people, house
--      numbers, mail, documents): booking_evidence.website_published_at;
--   3. only then is a copy placed in the public job-photos bucket, which the
--      service and city pages read. Unpublishing deletes that copy.
--
-- The private booking-evidence bucket is never made public.
-- Safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS website_photo_consent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS website_photo_consent_source TEXT;

ALTER TABLE public.booking_evidence
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

-- A published photo always says what it shows and where it lives.
ALTER TABLE public.booking_evidence
  DROP CONSTRAINT IF EXISTS booking_evidence_website_published_complete;
ALTER TABLE public.booking_evidence
  ADD CONSTRAINT booking_evidence_website_published_complete CHECK (
    website_published_at IS NULL
    OR (website_service IS NOT NULL
        AND website_public_path IS NOT NULL
        AND website_alt IS NOT NULL AND length(btrim(website_alt)) >= 10)
  );

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
-- Expected: 8 rows.
SELECT id, public FROM storage.buckets WHERE id = 'job-photos';
-- Expected: job-photos | true
