-- ============================================================
-- Migration 089: finalize approval for a waitlisted application
--
-- WHAT 088 MISSED
-- Approving runs TWO functions. 088 fixed the first (claim) and I shipped it
-- without checking the second, so the owner got past "already in progress"
-- straight into:
--
--   "Easer approval requirements changed before finalization"  (23514)
--
-- finalize_easer_application_approval carried the same applied-only predicate.
-- It lives in migration 043, not 037 — 043 split approval away from job
-- readiness and superseded the older function, which is why grepping 037 alone
-- found the wrong copy.
--
-- THE FULL APPROVE PATH, so this is not half-fixed again:
--   claim_easer_application_decision      migration 088   fixed
--   finalize_easer_application_approval   this migration  fixed
--   finalize_easer_application_decision   reject only; its approve branch is
--                                         unreachable and its reject branch
--                                         blocks only active/approved, so a
--                                         waitlisted applicant can still be
--                                         rejected. No change needed.
--   getEaserApprovalReadiness             fixed in code
--
-- 'rejected' is still refused everywhere: that application was closed out and
-- the fee refunded.
--
-- Byte-identical to 043 apart from the one predicate.
-- ============================================================

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

  IF v_profile.application_status NOT IN ('applied', 'waitlist')
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

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (89, '089_finalize_waitlisted_approval')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT proname,
       pg_get_functiondef(oid) LIKE '%application_status NOT IN (''applied'', ''waitlist'')%' AS accepts_waitlist
  FROM pg_proc
 WHERE proname IN ('claim_easer_application_decision', 'finalize_easer_application_approval')
 ORDER BY proname;
-- Expected: both true. If either is false, approving a waitlisted applicant
-- still fails at that step.
