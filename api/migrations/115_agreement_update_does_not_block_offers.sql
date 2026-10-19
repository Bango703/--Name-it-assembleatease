-- ============================================================
-- Migration 115: a newer agreement version no longer blocks offers
--
-- Publishing agreement 2026-10-18 (migration 113) made every Easer who signed
-- an earlier version fail three database guards:
--   guard_easer_current_agreement_online     cannot go Online
--   guard_dispatch_offer_easer_readiness     cannot receive an offer
--   guard_booking_easer_closure_assignment   cannot be assigned a booking
--
-- Owner decision: jobs keep coming while an Easer signs the update. The
-- application treats the new version as a reminder (api/_easer-readiness.js).
-- This migration removes only the VERSION comparison from the guards.
-- Whether the Easer signed an agreement at all (contractor_agreement_signed_at)
-- is still enforced, untouched.
--
-- Same in-place rewrite technique as migration 091, so the long function
-- bodies are not retyped. Idempotent: a re-run finds nothing to replace.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_function_name TEXT;
  v_definition    TEXT;
  v_new           TEXT;
  v_pattern CONSTANT TEXT :=
    '[A-Za-z_]+\.contractor_agreement_version\s+IS\s+DISTINCT\s+FROM\s+COALESCE\(\s*public\.current_required_agreement_version\(\)\s*,\s*''[0-9-]+''\s*\)';
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

    IF v_definition !~ v_pattern THEN
      RAISE NOTICE 'guard % has no version comparison; skipping', v_function_name;
      CONTINUE;
    END IF;

    v_new := regexp_replace(v_definition, v_pattern, 'FALSE', 'g');
    EXECUTE v_new;
    v_patched := v_patched + 1;
  END LOOP;

  RAISE NOTICE 'agreement version comparisons removed from % guard(s)', v_patched;
END;
$$;

-- Prove it before commit: no guard compares versions any more.
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
    IF v_definition ~ 'contractor_agreement_version\s+IS\s+DISTINCT' THEN
      RAISE EXCEPTION 'Guard % still compares the agreement version', v_function_name;
    END IF;
    IF v_definition !~ 'contractor_agreement_signed_at\s+IS\s+NULL' THEN
      RAISE EXCEPTION 'Guard % lost its signed-at check', v_function_name;
    END IF;
  END LOOP;
END;
$$;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (115, 'agreement_update_does_not_block_offers')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';
