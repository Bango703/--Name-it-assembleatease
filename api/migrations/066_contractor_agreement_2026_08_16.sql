-- Migration 066: make the August 16, 2026 Contractor Agreement authoritative.
-- Approval remains separate from readiness. Existing assigned work remains
-- available, but an Easer must accept the current version before going Online
-- or receiving new assignments/offers.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_schema_state
     WHERE migration_number = 65
       AND migration_name = 'customer_legal_consent'
  ) THEN
    RAISE EXCEPTION 'Migration 065_customer_legal_consent.sql must be applied before migration 066';
  END IF;
END;
$$;

DO $$
DECLARE
  v_function_name TEXT;
  v_definition TEXT;
  v_old_version CONSTANT TEXT := '2026-07-13';
  v_new_version CONSTANT TEXT := '2026-08-16';
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
      RAISE EXCEPTION 'Required readiness function %.% is missing', 'public', v_function_name;
    END IF;
    IF POSITION(v_old_version IN v_definition) = 0
       AND POSITION(v_new_version IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Readiness function % has an unexpected agreement version', v_function_name;
    END IF;

    IF POSITION(v_old_version IN v_definition) > 0 THEN
      EXECUTE replace(v_definition, v_old_version, v_new_version);
    END IF;
  END LOOP;
END;
$$;

-- This trigger correctly blocks browser users from editing protected profile
-- state, but migration maintenance has no auth.uid(). Disable only this named
-- trigger for the single owner-controlled readiness correction, then restore it.
ALTER TABLE public.profiles DISABLE TRIGGER profiles_guard_self_update;

UPDATE public.profiles
   SET is_available = FALSE
 WHERE role = 'assembler'
   AND is_available IS TRUE
   AND (
     contractor_agreement_signed_at IS NULL
     OR contractor_agreement_version IS DISTINCT FROM '2026-08-16'
     OR code_of_conduct_agreed_at IS NULL
   );

ALTER TABLE public.profiles ENABLE TRIGGER profiles_guard_self_update;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (66, 'contractor_agreement_2026_08_16')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
