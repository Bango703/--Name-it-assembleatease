-- ============================================================
-- Migration 069: Repair the profiles.application_status CHECK constraint
--
-- SYMPTOM (live, blocking): submitting an Easer application fails with
--   "new row for relation \"profiles\" violates check constraint
--    \"profiles_application_status_check\""
-- and the applicant sees "Failed to save application."
--
-- CAUSE: api/assembler/apply.js inserts the new applicant with
--   application_status = 'payment_pending'
-- (introduced in commit 6a6b52f3, July 2026, so that a paid applicant stays
-- explicitly payment-pending until Stripe confirms the exact PaymentIntent and
-- owner review cannot start earlier). The live database still carries an older
-- CHECK constraint that predates that value and was never represented in this
-- migrations folder, so it rejects the insert.
--
-- The four real states the platform uses today:
--   payment_pending -> applied -> approved | rejected
--     payment_pending  api/assembler/apply.js       (insert)
--     applied          api/assembler/apply.js       (after fee confirmed)
--     approved         migration 043 / update.js    (owner approves)
--     rejected         migration 037 decision RPC   (owner rejects)
--
-- Plus one LEGACY state that must be preserved, not rewritten:
--     waitlist         no current code path writes or reads it
-- These rows predate the current design, where the Easer waitlist lives in its
-- own `assembler_waitlist` table with its own status column. They are real
-- people who once signed up. Rewriting them to 'applied' would inject them into
-- the owner's live review queue; rewriting to 'rejected' would silently reject
-- someone nobody actually rejected. Preserving the value is inert (no code
-- compares against it) and reversible, so the constraint simply tolerates it.
--
-- NULL must remain legal: `profiles` also holds CUSTOMER rows, which have no
-- application at all. A constraint that forbids NULL here would break customer
-- creation instead — the same outage moved somewhere worse.
--
-- Safe to re-run. Reads and reports what it removes rather than assuming a name,
-- because the stale constraint was added out-of-band and its name is not
-- guaranteed. Only constraints whose definition actually references
-- application_status are touched; the application_fee_refund_* and
-- application_decision_tuple constraints from migration 037 are left alone.
-- ============================================================

-- 1) Report any row that the new constraint would reject, BEFORE changing
--    anything. Expected to be zero rows; if it raises, stop and review the data
--    rather than widening the constraint to fit a bad value.
DO $$
DECLARE
  v_bad TEXT[];
BEGIN
  SELECT array_agg(DISTINCT application_status)
    INTO v_bad
    FROM public.profiles
   WHERE application_status IS NOT NULL
     AND application_status NOT IN ('payment_pending', 'applied', 'approved', 'rejected', 'waitlist');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'profiles.application_status holds unexpected value(s): %. Review these rows before applying migration 069.',
      array_to_string(v_bad, ', ');
  END IF;
END;
$$;

-- 1b) Surface how many legacy waitlist rows are being carried forward, so the
--     owner knows they exist rather than discovering them later.
DO $$
DECLARE
  v_legacy INTEGER;
BEGIN
  SELECT count(*) INTO v_legacy
    FROM public.profiles
   WHERE application_status = 'waitlist';
  IF v_legacy > 0 THEN
    RAISE NOTICE 'migration 069: preserving % legacy profile row(s) with application_status = waitlist (no code path reads this value)', v_legacy;
  END IF;
END;
$$;

-- 2) Drop every stale CHECK constraint on profiles that governs
--    application_status, whatever it happens to be named.
DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'profiles'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%application_status%'
  LOOP
    RAISE NOTICE 'migration 069: dropping stale constraint %', v_constraint.conname;
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$$;

-- 3) Install the constraint that matches what the application code actually
--    writes. NOT VALID is deliberately NOT used: step 1 already proved every
--    existing row conforms, so this validates immediately and protects reads.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_application_status_check
  CHECK (
    application_status IS NULL
    -- Four live states, plus the legacy 'waitlist' value documented above.
    OR application_status IN ('payment_pending', 'applied', 'approved', 'rejected', 'waitlist')
  );

-- 4) Record the migration so schema state stays auditable. Guarded: if migration
--    033 has not been applied in this database, the repair above still stands
--    and this bookkeeping step simply skips instead of erroring after the fix.
DO $$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (69, '069_profiles_application_status_check_repair')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$$;
