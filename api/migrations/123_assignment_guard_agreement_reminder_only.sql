-- ============================================================
-- Migration 123: assigning a job no longer requires the newest agreement
--
-- Migration 115 removed the agreement VERSION comparison from the three Easer
-- readiness guards (owner decision: an updated agreement is a reminder to sign,
-- never a gate). Migration 120 (Thumbtack external bookings) then recreated
-- guard_booking_easer_closure_assignment from an older body that still had the
-- comparison, so every Easer who signed an earlier version could get dispatch
-- offers but could not be assigned a booking by the owner (owner, 2026-10-28:
-- Thomas J Williams-Gibson, signed 2026-08-28; also Santiago, Carlos, Trapper).
--
-- Same patch as 115, run again: removes only the version comparison, keeps the
-- signed-at check, proves both before commit. Idempotent: a guard with nothing
-- to replace is skipped. scripts/test-agreement-guards-reminder-only.mjs fails
-- if a later migration brings the comparison back.
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
VALUES (123, 'assignment_guard_agreement_reminder_only')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';
