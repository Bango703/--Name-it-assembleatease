-- AssembleAtEase launch remediation SQL: migrations 031-033 only
-- Generated from the repository migration sources. Do not edit this copy by hand.
--
-- IMPORTANT:
-- * This is NOT a blank-database schema and does not include migrations 001-030.
-- * It expects an existing AssembleAtEase Supabase database through migration 030.
-- * Back up the database and apply this entire file in staging before production.
-- * Deploy matching application code and required secrets with these schema changes.
-- * The transaction rolls back all three sections if any statement or check fails.
--
-- SHA-256 d8b69288aaae83d1fe9ffab0aea36b6240b7436732e93033aa1ae996f7594d4a  api/migrations/031_security_privilege_hardening.sql
-- SHA-256 c7aa19ee5138d106c57839043ecf42a64b41d90b658ca014a89518040b50072d  api/migrations/032_payment_truth_and_customer_consent.sql
-- SHA-256 954fb7d83e35a2ecabc9ec44933db80c5e76141c326d13d620f24d7733d96439  api/migrations/033_launch_compliance_and_schema_state.sql

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, public, auth, extensions;

-- Prevent two operators from applying this remediation concurrently.
SELECT pg_advisory_xact_lock(hashtext('assembleatease-launch-remediation-031-033'));

-- Fail before changing state when the existing database is not at the required base.
DO $preflight$
DECLARE
  v_missing_tables text[];
  v_missing_columns text[];
BEGIN
  IF to_regnamespace('auth') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'Supabase auth schema/functions are required';
  END IF;

  IF to_regrole('anon') IS NULL
     OR to_regrole('authenticated') IS NULL
     OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'Supabase anon, authenticated, and service_role roles are required';
  END IF;

  SELECT array_agg(required.table_name ORDER BY required.table_name)
    INTO v_missing_tables
    FROM unnest(ARRAY[
      'profiles', 'bookings', 'payout_ledger', 'booking_evidence',
      'activity_logs', 'notification_log', 'dispatch_offers', 'booking_items',
      'financial_event_audit'
    ]) AS required(table_name)
   WHERE to_regclass(format('public.%I', required.table_name)) IS NULL;

  IF v_missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Required pre-031 tables are missing: %', array_to_string(v_missing_tables, ', ');
  END IF;

  SELECT array_agg(required.table_name || '.' || required.column_name
                   ORDER BY required.table_name, required.column_name)
    INTO v_missing_columns
    FROM (VALUES
      ('profiles', 'id'),
      ('profiles', 'full_name'),
      ('profiles', 'phone'),
      ('profiles', 'city'),
      ('profiles', 'state'),
      ('profiles', 'zip'),
      ('profiles', 'profile_photo'),
      ('profiles', 'is_available'),
      ('profiles', 'role'),
      ('profiles', 'status'),
      ('profiles', 'application_status'),
      ('profiles', 'identity_verified'),
      ('profiles', 'contractor_agreement_signed_at'),
      ('profiles', 'contractor_agreement_version'),
      ('profiles', 'code_of_conduct_agreed_at'),
      ('bookings', 'id'),
      ('bookings', 'ref'),
      ('bookings', 'status'),
      ('bookings', 'payment_status'),
      ('bookings', 'assembler_id'),
      ('bookings', 'assembler_name'),
      ('bookings', 'assembler_tier'),
      ('bookings', 'assembler_due'),
      ('bookings', 'amount_charged'),
      ('bookings', 'tax_amount'),
      ('bookings', 'stripe_fee'),
      ('bookings', 'service_call_fee'),
      ('bookings', 'payout_status'),
      ('bookings', 'payout_amount'),
      ('bookings', 'paid_out_at'),
      ('bookings', 'payout_notes'),
      ('bookings', 'platform_revenue'),
      ('bookings', 'service'),
      ('bookings', 'date'),
      ('payout_ledger', 'booking_id'),
      ('payout_ledger', 'booking_ref'),
      ('payout_ledger', 'assembler_id'),
      ('payout_ledger', 'assembler_name'),
      ('payout_ledger', 'assembler_tier'),
      ('payout_ledger', 'service'),
      ('payout_ledger', 'booking_date'),
      ('payout_ledger', 'amount_charged'),
      ('payout_ledger', 'assembler_due'),
      ('payout_ledger', 'payout_amount'),
      ('payout_ledger', 'platform_revenue'),
      ('payout_ledger', 'payout_notes'),
      ('payout_ledger', 'recorded_by'),
      ('payout_ledger', 'payout_method')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = required.table_name
        AND c.column_name = required.column_name
   );

  IF v_missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Required pre-031 columns are missing: %', array_to_string(v_missing_columns, ', ');
  END IF;
END;
$preflight$;

-- ============================================================================
-- REMEDIATION SECTION 1 OF 3: api/migrations/031_security_privilege_hardening.sql
-- ============================================================================
-- ============================================================
-- Migration 031: Profile/RPC privilege hardening
--
-- P0 controls:
-- 1. Remove the broad "update your own profile row" policy that let an
--    applicant self-approve, alter tier/membership, or spoof readiness.
-- 2. Replace it with one authenticated RPC that can update only the small
--    set of self-service profile fields used by the Easer UI.
-- 3. Revoke public execution of server-only financial/counter RPCs and set a
--    fixed search_path on SECURITY DEFINER functions.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_can_update_own_profile" ON public.profiles;

-- Remove any differently named UPDATE-only policy that may have been created
-- manually in an older environment. Service-role access is provided by the
-- existing ALL policy and is not affected.
DO $$
DECLARE
  v_policy text;
BEGIN
  FOR v_policy IN
    SELECT policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'profiles'
       AND cmd = 'UPDATE'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.profiles', v_policy);
  END LOOP;
END;
$$;

-- Defense in depth: even if a broad UPDATE policy is accidentally added
-- later, authenticated users still cannot change protected columns.
CREATE OR REPLACE FUNCTION public.guard_profile_self_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_allowed_keys CONSTANT text[] := ARRAY[
    'full_name', 'phone', 'city', 'state', 'zip', 'profile_photo', 'is_available'
  ];
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> OLD.id OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'Profile ownership is required' USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - v_allowed_keys) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed_keys) THEN
    RAISE EXCEPTION 'Protected profile fields cannot be changed by an Easer'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.identity_verified IS TRUE
     AND (NEW.full_name, NEW.city, NEW.state, NEW.zip)
         IS DISTINCT FROM (OLD.full_name, OLD.city, OLD.state, OLD.zip) THEN
    RAISE EXCEPTION 'Verified identity and location fields require owner review'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_available IS TRUE AND OLD.is_available IS NOT TRUE
     AND NOT COALESCE((
       NEW.role = 'assembler'
       AND NEW.status = 'active'
       AND NEW.application_status = 'approved'
       AND NEW.identity_verified IS TRUE
       AND NEW.contractor_agreement_signed_at IS NOT NULL
       AND NEW.code_of_conduct_agreed_at IS NOT NULL
     ), false) THEN
    RAISE EXCEPTION 'Easer is not ready to receive jobs' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_self_update ON public.profiles;
CREATE TRIGGER profiles_guard_self_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_self_update();

REVOKE ALL ON FUNCTION public.guard_profile_self_update() FROM PUBLIC, anon, authenticated;

-- The RPC accepts a JSON object so existing profile screens can make partial
-- updates without gaining write access to the profiles table. It always binds
-- the target row to auth.uid(); a browser-supplied user id is never accepted.
CREATE OR REPLACE FUNCTION public.update_own_easer_profile(p_updates jsonb)
RETURNS SETOF public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_allowed_keys CONSTANT text[] := ARRAY[
    'full_name', 'phone', 'city', 'state', 'zip', 'profile_photo', 'is_available'
  ];
  v_bad_keys text[];
BEGIN
  IF v_uid IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;

  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION 'A non-empty profile update object is required' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(key ORDER BY key)
    INTO v_bad_keys
    FROM jsonb_object_keys(p_updates) AS keys(key)
   WHERE NOT (key = ANY(v_allowed_keys));

  IF v_bad_keys IS NOT NULL THEN
    RAISE EXCEPTION 'Protected profile fields are not writable: %', array_to_string(v_bad_keys, ', ')
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_each(p_updates)
     WHERE key <> 'is_available'
       AND value <> 'null'::jsonb
       AND jsonb_typeof(value) <> 'string'
  ) THEN
    RAISE EXCEPTION 'Profile text fields must be strings or null' USING ERRCODE = '22023';
  END IF;

  IF p_updates ? 'is_available'
     AND (p_updates->'is_available' = 'null'::jsonb OR jsonb_typeof(p_updates->'is_available') <> 'boolean') THEN
    RAISE EXCEPTION 'is_available must be true or false' USING ERRCODE = '22023';
  END IF;

  IF p_updates ? 'full_name' AND length(btrim(COALESCE(p_updates->>'full_name', ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Full name must be between 1 and 120 characters' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'phone' AND length(COALESCE(p_updates->>'phone', '')) > 40 THEN
    RAISE EXCEPTION 'Phone number is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'city' AND length(COALESCE(p_updates->>'city', '')) > 120 THEN
    RAISE EXCEPTION 'City is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'state' AND length(COALESCE(p_updates->>'state', '')) > 32 THEN
    RAISE EXCEPTION 'State is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'zip' AND length(COALESCE(p_updates->>'zip', '')) > 10 THEN
    RAISE EXCEPTION 'ZIP is too long' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'profile_photo' AND length(COALESCE(p_updates->>'profile_photo', '')) > 1500000 THEN
    RAISE EXCEPTION 'Profile photo is too large' USING ERRCODE = '22023';
  END IF;
  IF p_updates ? 'profile_photo'
     AND NULLIF(p_updates->>'profile_photo', '') IS NOT NULL
     AND (p_updates->>'profile_photo') !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
     AND (p_updates->>'profile_photo') !~ '^https://[^"''<>[:space:]]+$' THEN
    RAISE EXCEPTION 'Profile photo must be a safe image data URL or HTTPS URL'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = v_uid
     AND role = 'assembler'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Easer profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_profile.identity_verified IS TRUE
     AND p_updates ?| ARRAY['full_name', 'city', 'state', 'zip'] THEN
    RAISE EXCEPTION 'Verified identity and location fields require owner review'
      USING ERRCODE = '42501';
  END IF;

  IF p_updates ? 'is_available'
     AND (p_updates->>'is_available')::boolean IS TRUE
     AND NOT COALESCE((
       v_profile.status = 'active'
       AND v_profile.application_status = 'approved'
       AND v_profile.identity_verified IS TRUE
       AND v_profile.contractor_agreement_signed_at IS NOT NULL
       AND v_profile.code_of_conduct_agreed_at IS NOT NULL
     ), false) THEN
    RAISE EXCEPTION 'Easer is not ready to receive jobs' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
     SET full_name = CASE WHEN p_updates ? 'full_name' THEN btrim(p_updates->>'full_name') ELSE full_name END,
         phone = CASE WHEN p_updates ? 'phone' THEN NULLIF(btrim(p_updates->>'phone'), '') ELSE phone END,
         city = CASE WHEN p_updates ? 'city' THEN NULLIF(btrim(p_updates->>'city'), '') ELSE city END,
         state = CASE WHEN p_updates ? 'state' THEN NULLIF(btrim(p_updates->>'state'), '') ELSE state END,
         zip = CASE WHEN p_updates ? 'zip' THEN NULLIF(btrim(p_updates->>'zip'), '') ELSE zip END,
         profile_photo = CASE WHEN p_updates ? 'profile_photo' THEN NULLIF(p_updates->>'profile_photo', '') ELSE profile_photo END,
         is_available = CASE WHEN p_updates ? 'is_available' THEN (p_updates->>'is_available')::boolean ELSE is_available END
   WHERE id = v_uid
   RETURNING * INTO v_profile;

  RETURN NEXT v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_easer_profile(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_own_easer_profile(jsonb) TO authenticated;

-- PostgreSQL grants function execution to PUBLIC by default. All functions in
-- this list are invoked only by service-key server code and must not be callable
-- through the anonymous/authenticated PostgREST API.
DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY(ARRAY[
         'increment_completed_jobs',
         'increment_active_jobs',
         'decrement_active_jobs',
         'increment_profile_counters',
         'record_booking_payout',
         'assemblecash_available_balance',
         'assemblecash_try_redeem',
         'customer_active_membership'
       ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_function);
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', v_function);
  END LOOP;
END;
$$;

-- Verification (run after applying):
-- SELECT policyname, cmd FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'profiles';
-- SELECT routine_name, grantee, privilege_type
--   FROM information_schema.routine_privileges
--  WHERE specific_schema = 'public'
--    AND routine_name IN ('update_own_easer_profile', 'assemblecash_try_redeem', 'record_booking_payout')
--  ORDER BY routine_name, grantee;

-- ============================================================================
-- REMEDIATION SECTION 2 OF 3: api/migrations/032_payment_truth_and_customer_consent.sql
-- ============================================================================
-- ============================================================
-- Migration 032: Payment truth and customer consent hardening
-- Apply after migration 031 and before deploying the matching APIs.
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guest_mutation_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS quote_amount_cents INTEGER,
  ADD COLUMN IF NOT EXISTS quote_subtotal_cents INTEGER,
  ADD COLUMN IF NOT EXISTS quote_tax_cents INTEGER,
  ADD COLUMN IF NOT EXISTS quote_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS quote_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_approval_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_terms_version TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_id TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_easer_due_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_easer_payout_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_bank_payout_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_bank_payout_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_bank_payout_paid_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_quote_token_hash
  ON bookings (quote_token_hash)
  WHERE quote_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_guest_mutation_token_hash
  ON bookings (guest_mutation_token_hash)
  WHERE guest_mutation_token_hash IS NOT NULL;

-- Manual payout remains the launch source of truth. The caller-provided amount
-- must exactly equal the canonical server-calculated due, and customer funds
-- must already be captured (including a captured cancellation fee).
-- Migration 010 created a four-argument overload. Drop it before installing
-- the canonical five-argument function so default arguments cannot make RPC
-- resolution ambiguous or leave the older, weaker payout path callable.
DROP FUNCTION IF EXISTS public.record_booking_payout(UUID, INTEGER, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.record_booking_payout(
  p_booking_id          UUID,
  p_payout_amount_cents INTEGER,
  p_notes               TEXT    DEFAULT NULL,
  p_recorded_by         TEXT    DEFAULT 'owner',
  p_payout_method       TEXT    DEFAULT 'manual'
)
RETURNS TABLE (
  booking_id       UUID,
  booking_ref      TEXT,
  assembler_id     UUID,
  assembler_name   TEXT,
  assembler_tier   TEXT,
  payout_amount    INTEGER,
  platform_revenue INTEGER,
  amount_charged   INTEGER,
  assembler_due    INTEGER,
  recorded_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_row            bookings%ROWTYPE;
  canonical_due_cents    INTEGER;
  amount_charged_cents   INTEGER;
  net_captured_cents     INTEGER;
  remaining_tax_cents    INTEGER;
  stripe_fee_cents       INTEGER;
  platform_revenue_cents INTEGER;
BEGIN
  SELECT * INTO booking_row FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF booking_row.status = 'completed' THEN
    IF booking_row.payment_status NOT IN ('captured', 'partially_refunded') THEN
      RAISE EXCEPTION 'Customer payment must be captured before payout. Current payment status: %', booking_row.payment_status USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.assembler_due, 0);
  ELSIF booking_row.status = 'cancelled' THEN
    IF booking_row.payment_status <> 'cancellation_fee_captured' THEN
      RAISE EXCEPTION 'Cancellation fee must be captured before cancellation earnings can be paid' USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.cancellation_easer_due_cents, 0);
  ELSE
    RAISE EXCEPTION 'Only completed jobs or fee-bearing cancellations can be paid out. Current status: %', booking_row.status USING ERRCODE = '22000';
  END IF;

  IF booking_row.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No Easer assigned to this booking' USING ERRCODE = '22000';
  END IF;
  IF booking_row.payout_status = 'paid' THEN
    RAISE EXCEPTION 'Payout already recorded for this booking.' USING ERRCODE = '23505';
  END IF;
  IF canonical_due_cents <= 0 OR p_payout_amount_cents IS DISTINCT FROM canonical_due_cents THEN
    RAISE EXCEPTION 'Payout amount must exactly equal canonical Easer earnings of % cents', canonical_due_cents USING ERRCODE = '22000';
  END IF;
  IF COALESCE(BTRIM(p_notes), '') = '' THEN
    RAISE EXCEPTION 'A bank confirmation ID or payout reference is required' USING ERRCODE = '22000';
  END IF;
  IF LOWER(COALESCE(p_payout_method, 'manual')) = 'stripe_connect' THEN
    RAISE EXCEPTION 'Stripe Connect transfers must be reconciled by Stripe state, not recorded as manual payouts' USING ERRCODE = '22000';
  END IF;

  amount_charged_cents := COALESCE(booking_row.amount_charged, 0);
  net_captured_cents := GREATEST(0, amount_charged_cents - COALESCE(booking_row.refund_amount, 0));
  remaining_tax_cents := CASE
    WHEN booking_row.status = 'cancelled' OR amount_charged_cents <= 0 THEN 0
    ELSE ROUND(COALESCE(booking_row.tax_amount, 0)::NUMERIC * net_captured_cents / amount_charged_cents)::INTEGER
  END;
  stripe_fee_cents := COALESCE(
    booking_row.stripe_fee,
    CASE WHEN net_captured_cents > 0 THEN ROUND(net_captured_cents * 0.029)::INTEGER + 30 ELSE 0 END
  );
  platform_revenue_cents := net_captured_cents - remaining_tax_cents - stripe_fee_cents - canonical_due_cents;

  UPDATE bookings SET
    payout_amount = canonical_due_cents,
    paid_out_at = NOW(),
    payout_notes = BTRIM(p_notes),
    payout_status = 'paid',
    platform_revenue = platform_revenue_cents,
    cancellation_easer_payout_status = CASE WHEN booking_row.status = 'cancelled' THEN 'paid' ELSE booking_row.cancellation_easer_payout_status END
  WHERE id = booking_row.id;

  INSERT INTO payout_ledger (
    booking_id, booking_ref, assembler_id, assembler_name, assembler_tier,
    service, booking_date, amount_charged, assembler_due, payout_amount,
    platform_revenue, payout_notes, recorded_by, payout_method
  ) VALUES (
    booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, booking_row.service,
    booking_row.date::text, amount_charged_cents, canonical_due_cents,
    canonical_due_cents, platform_revenue_cents, BTRIM(p_notes),
    COALESCE(p_recorded_by, 'owner'), LOWER(COALESCE(p_payout_method, 'manual'))
  );

  RETURN QUERY SELECT booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, canonical_due_cents,
    platform_revenue_cents, amount_charged_cents, canonical_due_cents, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

-- ============================================================================
-- REMEDIATION SECTION 3 OF 3: api/migrations/033_launch_compliance_and_schema_state.sql
-- ============================================================================
-- ============================================================
-- Migration 033: Launch compliance tracking and schema state
-- Apply after migration 032.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS w9_status TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS w9_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS w9_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS w9_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS w9_notes TEXT,
  ADD COLUMN IF NOT EXISTS account_closure_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_closure_status TEXT,
  ADD COLUMN IF NOT EXISTS account_closure_reason TEXT,
  ADD COLUMN IF NOT EXISTS auth_access_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auth_access_revoke_error TEXT;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_w9_status_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_w9_status_check
  CHECK (w9_status IN ('not_requested', 'requested', 'received', 'validated', 'not_required'));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_account_closure_status_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_account_closure_status_check
  CHECK (account_closure_status IS NULL OR account_closure_status IN ('requested', 'reviewing', 'cancelled', 'completed'));

-- Browser clients use authenticated APIs for bookings and evidence. Keeping
-- these base tables server-only prevents a permissive legacy policy or default
-- grant from exposing customer, payment, or assignment data through PostgREST.
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bookings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.bookings TO service_role;

ALTER TABLE public.booking_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "easer_insert_own_booking_evidence" ON public.booking_evidence;
DROP POLICY IF EXISTS "easer_select_own_evidence" ON public.booking_evidence;
REVOKE ALL ON TABLE public.booking_evidence FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_evidence TO service_role;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.easer_compliance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assembler_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  compliance_type TEXT NOT NULL CHECK (compliance_type IN ('w9')),
  status TEXT NOT NULL,
  notes TEXT,
  recorded_by TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_easer_compliance_events_assembler
  ON public.easer_compliance_events (assembler_id, created_at DESC);

ALTER TABLE public.easer_compliance_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.easer_compliance_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.easer_compliance_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_easer_w9_status(
  p_assembler_id UUID,
  p_status TEXT,
  p_notes TEXT DEFAULT NULL,
  p_recorded_by TEXT DEFAULT 'owner'
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_status NOT IN ('not_requested', 'requested', 'received', 'validated', 'not_required') THEN
    RAISE EXCEPTION 'Invalid W-9 status' USING ERRCODE = '22023';
  END IF;
  IF length(COALESCE(p_notes, '')) > 500 THEN
    RAISE EXCEPTION 'W-9 notes must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_notes, '') ~ '\m[0-9]{3}[- ]?[0-9]{2}[- ]?[0-9]{4}\M'
     OR COALESCE(p_notes, '') ~ '\m[0-9]{2}-?[0-9]{7}\M' THEN
    RAISE EXCEPTION 'Do not store SSNs, EINs, or raw W-9 contents in compliance notes' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
     SET w9_status = p_status,
         w9_notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
         w9_requested_at = CASE WHEN p_status = 'requested' THEN v_now ELSE w9_requested_at END,
         w9_received_at = CASE WHEN p_status IN ('received', 'validated') THEN v_now ELSE w9_received_at END,
         w9_validated_at = CASE WHEN p_status = 'validated' THEN v_now ELSE w9_validated_at END
   WHERE id = p_assembler_id
     AND role = 'assembler'
   RETURNING * INTO v_profile;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Easer not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.easer_compliance_events (
    assembler_id, compliance_type, status, notes, recorded_by
  ) VALUES (
    p_assembler_id, 'w9', p_status,
    NULLIF(btrim(COALESCE(p_notes, '')), ''),
    COALESCE(NULLIF(btrim(p_recorded_by), ''), 'owner')
  );

  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.record_easer_w9_status(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_easer_w9_status(UUID, TEXT, TEXT, TEXT) TO service_role;

CREATE TABLE IF NOT EXISTS public.platform_schema_state (
  migration_number INTEGER PRIMARY KEY,
  migration_name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.platform_schema_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_schema_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.platform_schema_state TO service_role;

-- Fail the migration if the launch-critical truth columns from migrations
-- 031-032 are not present in this database.
DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  IF to_regclass('public.activity_logs') IS NULL
     OR to_regclass('public.notification_log') IS NULL
     OR to_regclass('public.payout_ledger') IS NULL
     OR to_regclass('public.dispatch_offers') IS NULL
     OR to_regclass('public.booking_evidence') IS NULL
     OR to_regclass('public.booking_items') IS NULL
     OR to_regclass('public.financial_event_audit') IS NULL
     OR to_regclass('public.easer_compliance_events') IS NULL THEN
    RAISE EXCEPTION 'One or more launch-critical operational tables are missing';
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO v_missing
    FROM (VALUES
      ('bookings', 'guest_mutation_token_hash'),
      ('bookings', 'quote_approved_at'),
      ('bookings', 'refund_amount'),
      ('bookings', 'stripe_bank_payout_status'),
      ('bookings', 'stripe_fee'),
      ('bookings', 'service_call_fee'),
      ('bookings', 'tax_amount'),
      ('bookings', 'amount_charged'),
      ('bookings', 'assembler_due'),
      ('bookings', 'payout_status'),
      ('bookings', 'cancellation_easer_due_cents'),
      ('profiles', 'contractor_agreement_version'),
      ('profiles', 'w9_status')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = required.table_name
        AND c.column_name = required.column_name
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Launch-critical schema columns are missing: %', array_to_string(v_missing, ', ');
  END IF;
END;
$$;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (33, 'launch_compliance_and_schema_state')
ON CONFLICT (migration_number) DO UPDATE
  SET migration_name = EXCLUDED.migration_name,
      applied_at = NOW();

-- Verify the security and schema invariants before the transaction can commit.
DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_schema_state
     WHERE migration_number = 33
       AND migration_name = 'launch_compliance_and_schema_state'
  ) THEN
    RAISE EXCEPTION 'Migration 033 schema state was not recorded';
  END IF;

  IF to_regprocedure('public.record_booking_payout(uuid,integer,text,text)') IS NOT NULL
     OR to_regprocedure('public.record_booking_payout(uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Canonical payout RPC signature verification failed';
  END IF;

  IF to_regprocedure('public.update_own_easer_profile(jsonb)') IS NULL
     OR to_regprocedure('public.record_easer_w9_status(uuid,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Required remediation RPC is missing';
  END IF;

  IF has_function_privilege('anon',
       'public.record_booking_payout(uuid,integer,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.record_booking_payout(uuid,integer,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.record_booking_payout(uuid,integer,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Payout RPC privilege verification failed';
  END IF;

  IF has_function_privilege('anon',
       'public.update_own_easer_profile(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.update_own_easer_profile(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Easer self-service RPC privilege verification failed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'profiles'
       AND cmd = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'A direct authenticated profile UPDATE policy remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'public.profiles'::regclass
       AND tgname = 'profiles_guard_self_update'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Protected profile update trigger is missing';
  END IF;

  IF has_table_privilege('anon', 'public.bookings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.bookings', 'SELECT')
     OR has_table_privilege('anon', 'public.booking_evidence', 'SELECT')
     OR has_table_privilege('authenticated', 'public.booking_evidence', 'SELECT') THEN
    RAISE EXCEPTION 'Server-only booking/evidence table privileges remain exposed';
  END IF;
END;
$postflight$;

COMMIT;
