-- ============================================================
-- Migration 040: Allow the owner-manual completed Easer record-link
--
-- The owner also holds an Easer account and performs some manual (offline)
-- jobs personally. Those jobs must still be attributed to that Easer account so
-- history/records stay on the normal track. The API (api/booking/assign.js)
-- already permits this narrow link, but the migration-037 trigger still
-- rejected it because an owner-manual booking is never Stripe-authorized —
-- an API-level allowance cannot override a database trigger, so the link
-- failed with 'Customer payment must be verified before assignment'.
--
-- This migration replaces guard_booking_easer_closure_assignment() to skip the
-- Stripe-payment and new-job-readiness gates for EXACTLY ONE case:
--
--     NEW.source = 'owner_manual' AND NEW.status = 'completed'
--
-- i.e. a record-only link onto an already-finished offline job. Nothing else
-- changes:
--   * Online bookings still require Stripe authorized/deposit_paid to assign.
--   * A CONFIRMED (live) owner-manual booking still requires the payment gate,
--     so an unpaid job can never be dispatched to an Easer.
--   * The closure hold still applies — a closure-held Easer cannot be linked.
--   * The Easer profile must still exist and be role='assembler'.
--
-- Apply AFTER migration 038 (owner-manual columns). Safe to re-run.
-- ============================================================

BEGIN;

-- Fail fast instead of creating a trigger that would break every booking write.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'bookings'
       AND column_name = 'source'
  ) THEN
    RAISE EXCEPTION 'Apply migration 038 (owner-manual booking columns) before migration 040';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_booking_easer_closure_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_assignment_started BOOLEAN;
  v_readiness_guard_required BOOLEAN;
  v_payment_guard_required BOOLEAN;
  v_record_only_owner_manual BOOLEAN;
BEGIN
  IF NEW.assembler_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The one narrow allowance: attributing an already-completed offline job to
  -- an Easer account. No dispatch, no live work, no Stripe money is implied.
  v_record_only_owner_manual := COALESCE(NEW.source, 'online') = 'owner_manual'
    AND NEW.status = 'completed';

  IF TG_OP = 'INSERT' THEN
    v_assignment_started := TRUE;
  ELSE
    v_assignment_started := NEW.assembler_id IS DISTINCT FROM OLD.assembler_id
      OR (NEW.assembler_accepted_at IS NOT NULL AND OLD.assembler_accepted_at IS NULL)
      OR (
        NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
        AND NEW.assignment_token IS DISTINCT FROM OLD.assignment_token
      );
  END IF;

  v_payment_guard_required := (
    v_assignment_started
    OR (
      TG_OP = 'UPDATE'
      AND NEW.status IS DISTINCT FROM OLD.status
      AND NEW.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')
    )
  ) AND NOT v_record_only_owner_manual;
  v_readiness_guard_required := (
    v_assignment_started
    OR (
      TG_OP = 'UPDATE'
      AND NEW.status = 'confirmed'
      AND OLD.status IS DISTINCT FROM 'confirmed'
    )
  ) AND NOT v_record_only_owner_manual;

  IF v_payment_guard_required THEN
    IF COALESCE(NEW.total_price, 0) < 0 THEN
      RAISE EXCEPTION 'A negative-price booking cannot be assigned'
        USING ERRCODE = '23514';
    ELSIF COALESCE(NEW.total_price, 0) = 0 THEN
      IF NEW.confirmed_by IS DISTINCT FROM 'owner_zero_dollar_simulation' THEN
        RAISE EXCEPTION 'A zero-dollar booking cannot be assigned outside an explicit simulation'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.payment_status = 'authorized' THEN
      IF NEW.stripe_payment_intent_id IS NULL THEN
        RAISE EXCEPTION 'Authorized assignment requires its linked Stripe PaymentIntent'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.payment_status = 'deposit_paid' THEN
      IF COALESCE(NEW.deposit_amount, 0) <= 0
         OR COALESCE(NEW.deposit_amount, 0) > NEW.total_price
         OR COALESCE(NEW.stripe_deposit_intent_id, NEW.stripe_payment_intent_id) IS NULL THEN
        RAISE EXCEPTION 'Deposit assignment requires a valid paid deposit and linked Stripe PaymentIntent'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Customer payment must be verified before assignment or acceptance'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = NEW.assembler_id
     AND role = 'assembler'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned Easer profile not found' USING ERRCODE = '23503';
  END IF;

  -- Closure hold still applies to every case, including the record-only link.
  IF COALESCE(v_profile.account_closure_status, '') IN ('requested', 'reviewing', 'completed')
     AND NEW.status IN ('confirmed', 'en_route', 'arrived', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'A closure-held Easer cannot receive or retain a live assignment'
      USING ERRCODE = '23514';
  END IF;

  IF v_readiness_guard_required THEN
    IF v_profile.status IS DISTINCT FROM 'active'
       OR v_profile.application_status IS DISTINCT FROM 'approved'
       OR v_profile.identity_verified IS NOT TRUE
       OR v_profile.contractor_agreement_signed_at IS NULL
       OR v_profile.contractor_agreement_version IS DISTINCT FROM '2026-07-13'
       OR v_profile.code_of_conduct_agreed_at IS NULL
       OR NULLIF(BTRIM(COALESCE(v_profile.phone, '')), '') IS NULL
       OR v_profile.is_available IS NOT TRUE
       OR v_profile.tier IS NULL
       OR v_profile.tier NOT IN ('starter', 'professional', 'elite', 'verified')
       OR v_profile.application_fee_refunded IS TRUE
       OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
       OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
       OR v_profile.application_fee_refund_review_required_at IS NOT NULL
       OR NOT (
         v_profile.application_fee_paid IS TRUE
         OR v_profile.application_fee_waived IS TRUE
         OR v_profile.fee_waived_by_owner IS TRUE
       )
       OR v_profile.application_decision_key IS NOT NULL
       OR COALESCE(v_profile.account_closure_status, '') IN ('requested', 'reviewing', 'completed') THEN
      RAISE EXCEPTION 'Assigned Easer is not ready and eligible for jobs'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_guard_easer_closure_assignment ON public.bookings;
CREATE TRIGGER bookings_guard_easer_closure_assignment
  BEFORE INSERT OR UPDATE OF assembler_id, assembler_accepted_at, assigned_at,
    assignment_token, status ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_booking_easer_closure_assignment();

REVOKE ALL ON FUNCTION public.guard_booking_easer_closure_assignment()
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (40, 'owner_manual_easer_record_link')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
