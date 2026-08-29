-- ============================================================
-- Migration 090: agreement versions and an immutable acceptance ledger
--
-- WHAT EXISTS TODAY, AND WHY IT IS NOT ENOUGH
-- The current agreement version is a hardcoded constant in application code
-- (CONTRACTOR_AGREEMENT_VERSION = '2026-08-28'). Publishing therefore means
-- editing a line and deploying, which couples a contractual act to a software
-- release. Policy is explicit that these are separate systems.
--
-- Acceptance lives as five columns on profiles. There is no history anywhere.
-- When an Easer accepts a new version those columns are OVERWRITTEN, so the
-- record of what they previously agreed to is destroyed. Two live Easers are
-- currently on older versions (2026-06-08 and 2026-07-13); that evidence is one
-- UPDATE away from being gone. In a dispute about what someone signed up to,
-- it is the only thing that matters.
--
-- WHAT THIS ADDS
--   agreement_versions     draft / published / superseded, with the exact
--                          content and a hash, so what was published can be
--                          proven rather than reconstructed
--   agreement_acceptances  append-only. One row per person per version, never
--                          updated, never deleted
--
-- The profiles columns are deliberately LEFT IN PLACE and keep working. They
-- become a fast cache of the newest acceptance; the ledger becomes the truth.
-- Removing them would break readiness, apply, and approval in one step, which
-- is precisely the kind of coupled change that has cost this platform already.
--
-- A DRAFT MUST BE INERT. Editing the next version cannot change anyone's
-- eligibility, take them offline, or notify them. Only publishing does that,
-- which is why status is explicit rather than inferred from dates.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.agreement_versions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'easer' today. Named now so customer Terms and the Privacy Notice can use
  -- the same machinery without a second system growing beside this one.
  document        TEXT        NOT NULL DEFAULT 'easer_agreement',
  version         TEXT        NOT NULL,

  -- draft      accumulating changes; invisible to Easers, affects nobody
  -- published  the one currently required
  -- superseded a previous published version, kept forever
  status          TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published', 'superseded')),

  -- Material changes require re-acceptance. Typos and formatting must not drag
  -- the whole network through an acceptance wall.
  is_material     BOOLEAN     NOT NULL DEFAULT TRUE,
  is_emergency    BOOLEAN     NOT NULL DEFAULT FALSE,

  content         TEXT,
  content_hash    TEXT,
  change_summary  TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at    TIMESTAMPTZ,
  effective_at    TIMESTAMPTZ,
  published_by    TEXT,

  CONSTRAINT agreement_versions_unique UNIQUE (document, version),

  -- A published version must say when, and must carry the content it published.
  -- "We published something on this date" without the text is not a record.
  CONSTRAINT agreement_versions_published_complete CHECK (
    status <> 'published'
    OR (published_at IS NOT NULL AND content IS NOT NULL AND content_hash IS NOT NULL)
  )
);

-- EXACTLY ONE published version per document. Two would make "which agreement
-- am I required to accept" unanswerable, and every gate would pick arbitrarily.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_one_published
  ON public.agreement_versions (document)
  WHERE status = 'published';

-- One draft at a time, for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_one_draft
  ON public.agreement_versions (document)
  WHERE status = 'draft';

-- ── The ledger ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agreement_acceptances (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  document          TEXT        NOT NULL DEFAULT 'easer_agreement',
  version           TEXT        NOT NULL,
  -- The hash AS ACCEPTED. If a published row were ever altered, comparing this
  -- proves what the person actually saw.
  content_hash      TEXT,
  accepted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_name       TEXT,
  ip                TEXT,
  user_agent        TEXT,
  -- 'backfill' marks rows reconstructed from the profiles columns, which carry
  -- no hash and no signature. They are real acceptances but weaker evidence,
  -- and must not be presented as equal to one captured at the time.
  source            TEXT        NOT NULL DEFAULT 'live'
                      CHECK (source IN ('live', 'backfill')),

  CONSTRAINT agreement_acceptances_once UNIQUE (profile_id, document, version)
);

-- ON DELETE RESTRICT above: an acceptance must outlive account cleanup. Deleting
-- a profile must fail loudly rather than silently erasing what they agreed to.

CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_profile
  ON public.agreement_acceptances (profile_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_version
  ON public.agreement_acceptances (document, version);

-- Append-only, enforced by the database rather than by convention. A ledger
-- that application code can rewrite is not a ledger.
CREATE OR REPLACE FUNCTION public.agreement_acceptances_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'agreement_acceptances is append-only: acceptance records cannot be % once written', TG_OP
    USING ERRCODE = '23514';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_agreement_acceptances_no_update ON public.agreement_acceptances;
CREATE TRIGGER trg_agreement_acceptances_no_update
  BEFORE UPDATE OR DELETE ON public.agreement_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.agreement_acceptances_immutable();

-- ── Preserve what already exists ────────────────────────────────────────────
-- Every current acceptance becomes a ledger row before anything can overwrite
-- the profiles columns. Two Easers are on older versions; this is the moment
-- that evidence stops being one UPDATE from gone.
INSERT INTO public.agreement_acceptances
  (profile_id, document, version, accepted_at, signed_name, ip, user_agent, source)
SELECT p.id,
       'easer_agreement',
       p.contractor_agreement_version,
       COALESCE(p.contractor_agreement_signed_at, NOW()),
       p.contractor_agreement_signed_name,
       p.contractor_agreement_ip,
       p.contractor_agreement_user_agent,
       'backfill'
  FROM public.profiles p
 WHERE p.role = 'assembler'
   AND p.contractor_agreement_version IS NOT NULL
   AND p.contractor_agreement_signed_at IS NOT NULL
ON CONFLICT (profile_id, document, version) DO NOTHING;

-- Record the version currently in force, so the gate has something to read the
-- moment the code starts reading from here instead of a constant.
INSERT INTO public.agreement_versions
  (document, version, status, is_material, content, content_hash, change_summary, published_at, effective_at, published_by)
VALUES
  ('easer_agreement', '2026-08-28', 'published', TRUE,
   'Imported from assembler/contractor-agreement.html at migration 090. Replaced with exact stored content on the next publish.',
   'imported-090',
   'Version in force before agreement versioning existed.',
   NOW(), NOW(), 'migration_090')
ON CONFLICT (document, version) DO NOTHING;

-- Older versions people are still on, so their acceptance points at a real row.
INSERT INTO public.agreement_versions (document, version, status, is_material, change_summary)
SELECT DISTINCT 'easer_agreement', a.version, 'superseded', TRUE,
       'Reconstructed from an existing acceptance during migration 090.'
  FROM public.agreement_acceptances a
 WHERE a.document = 'easer_agreement'
   AND a.version <> '2026-08-28'
ON CONFLICT (document, version) DO NOTHING;

ALTER TABLE public.agreement_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_acceptances ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agreement_versions' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON public.agreement_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agreement_acceptances' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON public.agreement_acceptances FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END;
$do$;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (90, '090_agreement_versioning')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT version, status, is_material, published_at IS NOT NULL AS has_published_at
  FROM public.agreement_versions WHERE document = 'easer_agreement' ORDER BY version;
-- Expected: 2026-08-28 published, plus any older versions as superseded.

SELECT version, source, COUNT(*) AS acceptances
  FROM public.agreement_acceptances GROUP BY version, source ORDER BY version;
-- Expected: one row per Easer who had an acceptance, all source='backfill'.

-- The ledger must refuse to be rewritten.
-- Expected: ERROR "agreement_acceptances is append-only".
-- UPDATE public.agreement_acceptances SET signed_name = 'tamper' WHERE TRUE;
