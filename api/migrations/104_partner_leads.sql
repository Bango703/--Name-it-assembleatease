-- 104: Partner pipeline (move-in referral channel).
--
-- WHY. The first jobs come from people who stand next to a customer at the
-- moment they need assembly: leasing offices, property managers, movers,
-- realtors, furniture stores (business-artifacts/partner-outreach-kit.md).
-- Outreach was tracked in a sheet, outside the dashboard, and nothing could say
-- which partner sent which booking.
--
-- Each partner gets a ref_code. Their booking link carries it as
-- utm_campaign, which bookings.booking_attribution already records (056), so
-- bookings per partner are counted from the booking record itself. No booking,
-- payment, payout or dispatch column is touched here.
--
-- Stage and kind values are owned by api/_partners.js; the CHECKs below must
-- list the same values (scripts/test-partner-pipeline.mjs holds them equal).
--
-- Code is safe before this runs: /api/owner/partners reports the table as
-- missing and the Partners panel says to run this migration.

BEGIN;

CREATE TABLE IF NOT EXISTS public.partner_leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code            TEXT NOT NULL UNIQUE,
  place_id            TEXT UNIQUE,
  source              TEXT NOT NULL DEFAULT 'manual',
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,
  category            TEXT,
  city                TEXT,
  address             TEXT,
  phone               TEXT,
  email               TEXT,
  website             TEXT,
  maps_url            TEXT,
  social              JSONB NOT NULL DEFAULT '[]'::JSONB,
  rating              NUMERIC(2,1),
  review_count        INTEGER,
  rank                INTEGER,
  stage               TEXT NOT NULL DEFAULT 'to_contact',
  notes               TEXT,
  follow_up_on        DATE,
  first_contacted_on  DATE,
  last_contacted_on   DATE,
  history             JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.partner_leads DROP CONSTRAINT IF EXISTS partner_leads_stage_check;
ALTER TABLE public.partner_leads ADD CONSTRAINT partner_leads_stage_check
  CHECK (stage IN ('to_contact', 'contacted', 'interested', 'partner', 'not_a_fit'));

ALTER TABLE public.partner_leads DROP CONSTRAINT IF EXISTS partner_leads_kind_check;
ALTER TABLE public.partner_leads ADD CONSTRAINT partner_leads_kind_check
  CHECK (kind IN ('property_manager', 'apartment', 'mover', 'realtor', 'furniture'));

ALTER TABLE public.partner_leads DROP CONSTRAINT IF EXISTS partner_leads_source_check;
ALTER TABLE public.partner_leads ADD CONSTRAINT partner_leads_source_check
  CHECK (source IN ('google_maps', 'manual'));

ALTER TABLE public.partner_leads DROP CONSTRAINT IF EXISTS partner_leads_ref_code_format;
ALTER TABLE public.partner_leads ADD CONSTRAINT partner_leads_ref_code_format
  CHECK (ref_code ~ '^[a-z0-9]{6}$');

CREATE INDEX IF NOT EXISTS idx_partner_leads_stage ON public.partner_leads(stage);
CREATE INDEX IF NOT EXISTS idx_partner_leads_follow_up ON public.partner_leads(follow_up_on)
  WHERE follow_up_on IS NOT NULL;

-- Server-only table: the service role reads and writes it; no client access.
ALTER TABLE public.partner_leads ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (104, 'partner_leads')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
