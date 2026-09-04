-- ============================================================
-- Migration 091: the required agreement version has ONE source, not four
--
-- WHAT BROKE, AND WHO IT COST
-- Phillip Hawkins emailed on 2026-09-03: toggling Online returned
--
--     "Complete current Easer job-readiness requirements before going Online"
--
-- He was active, approved, identity-verified, code-of-conduct signed, on tier
-- 'starter', with a valid phone, and holding the CURRENT agreement 2026-08-28.
-- The application agreed: getEaserReadiness returned isReady=true with an empty
-- missingItems. The database refused him anyway.
--
-- Three trigger functions each carry their own hardcoded copy of the required
-- version. Migration 066 string-replaced '2026-07-13' with '2026-08-16' in all
-- three. When the agreement was later bumped to '2026-08-28' in application code
-- (CONTRACTOR_AGREEMENT_VERSION), nothing updated the database copies. They are
-- still demanding 2026-08-16.
--
-- The effect is exactly backwards: accepting the CURRENT agreement is what locks
-- an Easer out. Three gates, all of them:
--
--   guard_easer_current_agreement_online     cannot go Online
--   guard_dispatch_offer_easer_readiness     cannot receive an offer
--   guard_booking_easer_closure_assignment   cannot be assigned a booking
--
-- Nobody noticed because Trapper and Travis went Online BEFORE the bump, and the
-- trigger only fires on the transition into available. Every Easer onboarded
-- since has been unable to start. That is the entire supply pipeline.
--
-- WHY NOT JUST BUMP THE LITERAL AGAIN
-- Because that is what produced this outage, and it would produce the next one.
-- This is Constitution Article 1 and 2: one rule, one owner. Migration 090
-- created agreement_versions as the source of truth for exactly this question.
-- These guards now ask it instead of holding a fourth and fifth copy.
--
-- FAIL-OPEN ON VERSION CURRENCY, NEVER ON ACCEPTANCE
-- COALESCE keeps the old literal as a fallback, so if agreement_versions were
-- ever empty the behaviour is today's rather than a locked-out network. Version
-- CURRENCY is the only thing that degrades. Whether the Easer signed at all is
-- still checked by contractor_agreement_signed_at IS NULL in every guard, and
-- that is untouched.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.agreement_versions') IS NULL THEN
    RAISE EXCEPTION 'Migration 090_agreement_versioning.sql must be applied before 091';
  END IF;
END;
$$;

-- The one answer to "which agreement is required right now".
-- STABLE, not VOLATILE: it is a lookup, and triggers call it per row.
CREATE OR REPLACE FUNCTION public.current_required_agreement_version()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT version
    FROM public.agreement_versions
   WHERE document = 'easer_agreement'
     AND status = 'published'
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_required_agreement_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_required_agreement_version() TO authenticated, service_role;

COMMENT ON FUNCTION public.current_required_agreement_version() IS
  'Single source of truth for the required Easer agreement version. Reads the published row in agreement_versions. Never hardcode a version beside this.';

-- Rewrite the three guards in place, the same technique migration 066 used, so
-- the long function bodies are not retyped and nothing else in them changes.
DO $$
DECLARE
  v_function_name TEXT;
  v_definition    TEXT;
  v_new           TEXT;
  v_stale CONSTANT TEXT := '''2026-08-16''';
  -- COALESCE means an empty agreement_versions degrades to today's behaviour
  -- instead of locking every Easer out.
  v_replacement CONSTANT TEXT := 'COALESCE(public.current_required_agreement_version(), ''2026-08-16'')';
  v_patched INT := 0;
BEGIN
  FOREACH v_function_name IN ARRAY ARRAY[
    'guard_easer_current_agreement_online',
    'guard_booking_easer_closure_assignment',
    'guard_dispatch_offer_easer_readiness'
  ]
  LOOP
    SELECT pg_get_functiondef(p.oid)
      INTO v_definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_function_name
       AND pg_get_function_identity_arguments(p.oid) = '';

    IF v_definition IS NULL THEN
      RAISE EXCEPTION 'Readiness guard %.% is missing', 'public', v_function_name;
    END IF;

    -- Idempotent: a re-run must not wrap the call a second time.
    IF POSITION('current_required_agreement_version' IN v_definition) > 0 THEN
      RAISE NOTICE 'guard % already reads the single source; skipping', v_function_name;
      CONTINUE;
    END IF;

    IF POSITION(v_stale IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'Guard % does not contain the expected hardcoded version %. Refusing to patch a body this migration does not recognise.',
        v_function_name, v_stale;
    END IF;

    v_new := replace(v_definition, v_stale, v_replacement);
    EXECUTE v_new;
    v_patched := v_patched + 1;
  END LOOP;

  RAISE NOTICE 'agreement version guards patched: %', v_patched;
END;
$$;

-- Prove it took, in the same transaction, before anything is committed.
DO $$
DECLARE
  v_function_name TEXT;
  v_definition    TEXT;
BEGIN
  FOREACH v_function_name IN ARRAY ARRAY[
    'guard_easer_current_agreement_online',
    'guard_booking_easer_closure_assignment',
    'guard_dispatch_offer_easer_readiness'
  ]
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_function_name
       AND pg_get_function_identity_arguments(p.oid) = '';
    IF POSITION('current_required_agreement_version' IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Guard % still does not read the single source', v_function_name;
    END IF;
  END LOOP;
END;
$$;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (91, 'agreement_version_single_source')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT public.current_required_agreement_version() AS required_version;
-- Expected: 2026-08-28 (the published row from migration 090).

SELECT p.proname,
       POSITION('current_required_agreement_version' IN pg_get_functiondef(p.oid)) > 0 AS reads_single_source,
       POSITION('''2026-08-16''' IN pg_get_functiondef(p.oid)) > 0 AS still_has_literal_fallback
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('guard_easer_current_agreement_online',
                     'guard_booking_easer_closure_assignment',
                     'guard_dispatch_offer_easer_readiness');
-- Expected: all three reads_single_source = true.

-- Who can go Online now. Phillip Hawkins must no longer be blocked on version.
SELECT full_name,
       contractor_agreement_version,
       contractor_agreement_version = public.current_required_agreement_version() AS agreement_current,
       status, application_status, is_available
  FROM public.profiles
 WHERE role = 'assembler' AND application_status = 'approved'
 ORDER BY full_name;
