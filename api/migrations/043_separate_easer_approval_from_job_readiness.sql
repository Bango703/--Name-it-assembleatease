-- ============================================================
-- Migration 043: Separate owner approval from job readiness
--
-- Owner approval is an application decision. It activates the account but
-- deliberately leaves the Easer offline. Job readiness is a later operational
-- decision and requires the current agreement, code of conduct, valid phone,
-- identity, fee truth, tier, and no closure/refund hold.
--
-- This migration:
--   1. adds a row-locked approval finalizer that does not require the current
--      agreement merely to approve an otherwise valid applicant;
--   2. enforces the current agreement at the database boundary whenever an
--      Easer attempts to transition Online; and
--   3. takes any already-Online Easer with an outdated agreement Offline.
--
-- Existing accepted assignments remain usable through the assigned-work API
-- authorization path. Only Online/new-work eligibility is blocked.
-- Apply AFTER migration 042. Safe to re-run.
-- ============================================================

BEGIN;

-- Approval-only finalizer. The existing generic finalizer remains authoritative
-- for rejection/refund handling; the API routes approval through this narrower
-- function so agreement readiness cannot disable the owner's decision.
CREATE OR REPLACE FUNCTION public.finalize_easer_application_approval(
  p_assembler_id UUID,
  p_operation_key TEXT,
  p_expected_snapshot JSONB,
  p_decided_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  result_action TEXT,
  status TEXT,
  application_status TEXT,
  application_fee_refund_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_operation_key TEXT := BTRIM(COALESCE(p_operation_key, ''));
  v_paid_mode BOOLEAN;
  v_waived_mode BOOLEAN;
  v_decided_at TIMESTAMPTZ := COALESCE(p_decided_at, NOW());
BEGIN
  IF p_assembler_id IS NULL
     OR v_operation_key = ''
     OR length(v_operation_key) > 240
     OR jsonb_typeof(p_expected_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid Easer application approval finalization'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = p_assembler_id
     AND role = 'assembler'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Easer profile not found' USING ERRCODE = 'P0002';
  END IF;

  v_paid_mode := v_profile.application_fee_paid IS TRUE
    AND v_profile.payment_confirmed IS TRUE
    AND v_profile.application_fee_waived IS NOT TRUE
    AND v_profile.fee_waived_by_owner IS NOT TRUE;
  v_waived_mode := v_profile.application_fee_paid IS NOT TRUE
    AND v_profile.payment_confirmed IS NOT TRUE
    AND (
      v_profile.application_fee_waived IS TRUE
      OR v_profile.fee_waived_by_owner IS TRUE
    );

  -- Idempotent retry after a response was lost. Agreement and availability are
  -- intentionally absent: approval may be complete while job readiness is not.
  IF v_profile.status = 'active'
     AND v_profile.application_status = 'approved'
     AND v_profile.application_decision_key IS NULL THEN
    IF v_paid_mode = v_waived_mode
       OR v_profile.application_fee_refunded IS TRUE
       OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
       OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
       OR v_profile.application_fee_refund_review_required_at IS NOT NULL
       OR v_profile.application_fee_refund_id IS NOT NULL
       OR v_profile.application_fee_refunded_at IS NOT NULL
       OR (
         v_paid_mode
         AND (
           v_profile.stripe_payment_intent_id IS NULL
           OR v_profile.stripe_customer_id IS NULL
         )
       ) THEN
      RAISE EXCEPTION 'Finalized approval fee or refund truth is inconsistent'
        USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT 'already_finalized'::TEXT, v_profile.status,
      v_profile.application_status, v_profile.application_fee_refund_id;
    RETURN;
  END IF;

  IF v_profile.application_decision_type IS DISTINCT FROM 'approve'
     OR v_profile.application_decision_key IS DISTINCT FROM v_operation_key THEN
    RAISE EXCEPTION 'The exact Easer application approval claim is not held'
      USING ERRCODE = '55P03';
  END IF;
  IF public.easer_application_decision_snapshot(v_profile)
       IS DISTINCT FROM p_expected_snapshot THEN
    RAISE EXCEPTION 'Easer profile state changed before application approval finalization'
      USING ERRCODE = '40001';
  END IF;

  IF v_profile.application_status IS DISTINCT FROM 'applied'
     OR COALESCE(v_profile.status, 'pending') NOT IN ('pending', 'applied')
     OR v_profile.identity_verified IS NOT TRUE
     OR COALESCE(v_profile.account_closure_status, '') IN ('requested', 'reviewing', 'completed') THEN
    RAISE EXCEPTION 'Easer approval requirements changed before finalization'
      USING ERRCODE = '23514';
  END IF;
  IF v_paid_mode = v_waived_mode THEN
    RAISE EXCEPTION 'Application fee truth must be exactly one of paid or waived'
      USING ERRCODE = '23514';
  END IF;
  IF v_profile.application_fee_refunded IS TRUE
     OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
     OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
     OR v_profile.application_fee_refund_review_required_at IS NOT NULL
     OR v_profile.application_fee_refund_id IS NOT NULL
     OR v_profile.application_fee_refunded_at IS NOT NULL THEN
    RAISE EXCEPTION 'A refunded application cannot be approved'
      USING ERRCODE = '23514';
  END IF;
  IF v_paid_mode
     AND (
       v_profile.stripe_payment_intent_id IS NULL
       OR v_profile.stripe_customer_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Paid application Stripe identifiers are incomplete'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.profiles
     SET status = 'active',
         application_status = 'approved',
         tier = 'starter',
         previous_tier = NULL,
         is_available = FALSE,
         approved_at = COALESCE(approved_at, v_decided_at),
         application_decision_key = NULL,
         application_decision_type = NULL,
         application_decision_started_at = NULL
   WHERE id = p_assembler_id;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = p_assembler_id;

  RETURN QUERY SELECT 'applied'::TEXT, v_profile.status,
    v_profile.application_status, v_profile.application_fee_refund_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_easer_application_approval(
  UUID, TEXT, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_easer_application_approval(
  UUID, TEXT, JSONB, TIMESTAMPTZ
) TO service_role;

-- New agreement versions must take previously Online Easers out of new-work
-- circulation. This is a readiness correction only; approval is preserved.
UPDATE public.profiles
   SET is_available = FALSE
 WHERE role = 'assembler'
   AND is_available IS TRUE
   AND (
     contractor_agreement_signed_at IS NULL
     OR contractor_agreement_version IS DISTINCT FROM '2026-07-13'
     OR code_of_conduct_agreed_at IS NULL
   );

CREATE OR REPLACE FUNCTION public.guard_easer_current_agreement_online()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_phone_digits TEXT;
BEGIN
  IF NEW.role IS DISTINCT FROM 'assembler' THEN
    RETURN NEW;
  END IF;

  IF NEW.is_available IS TRUE
     AND (
       TG_OP = 'INSERT'
       OR OLD.is_available IS NOT TRUE
     ) THEN
    v_phone_digits := regexp_replace(COALESCE(NEW.phone, ''), '[^0-9]', '', 'g');
    IF length(v_phone_digits) = 11 AND left(v_phone_digits, 1) = '1' THEN
      v_phone_digits := substring(v_phone_digits FROM 2);
    END IF;

    IF NEW.status IS DISTINCT FROM 'active'
       OR NEW.application_status IS DISTINCT FROM 'approved'
       OR NEW.identity_verified IS NOT TRUE
       OR NEW.contractor_agreement_signed_at IS NULL
       OR NEW.contractor_agreement_version IS DISTINCT FROM '2026-07-13'
       OR NEW.code_of_conduct_agreed_at IS NULL
       OR length(v_phone_digits) <> 10
       OR NEW.tier IS NULL
       OR NEW.tier NOT IN ('starter', 'professional', 'elite', 'verified')
       OR NEW.application_fee_refunded IS TRUE
       OR COALESCE(NEW.application_fee_refunded_cents, 0) <> 0
       OR COALESCE(NEW.application_fee_refund_pending_cents, 0) <> 0
       OR NEW.application_fee_refund_review_required_at IS NOT NULL
       OR NOT (
         NEW.application_fee_paid IS TRUE
         OR NEW.application_fee_waived IS TRUE
         OR NEW.fee_waived_by_owner IS TRUE
       )
       OR NEW.application_decision_key IS NOT NULL
       OR COALESCE(NEW.account_closure_status, '') IN ('requested', 'reviewing', 'completed') THEN
      RAISE EXCEPTION 'Complete current Easer job-readiness requirements before going Online'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_current_agreement_online ON public.profiles;
CREATE TRIGGER profiles_guard_current_agreement_online
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_easer_current_agreement_online();

REVOKE ALL ON FUNCTION public.guard_easer_current_agreement_online()
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (43, 'separate_easer_approval_from_job_readiness')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
