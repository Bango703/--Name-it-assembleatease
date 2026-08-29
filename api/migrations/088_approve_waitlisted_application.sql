-- ============================================================
-- Migration 088: a waitlisted application can still be approved
--
-- THE BUG
-- Waitlisting an applicant sets application_status='waitlist'. This function
-- required it to be exactly 'applied' before an approval could be claimed, so
-- the moment the owner waitlisted someone, approving them raised:
--
--   "Only a submitted pending application can be approved"  (ERRCODE 23514)
--
-- The API then rewrote that as "Another application decision or profile update
-- is already in progress", sending the owner to look for a lock that did not
-- exist. Phil Hawkins' application_decision_key was null the whole time.
--
-- This is the SAME root cause that broke the readiness gate and produced
-- "cannot be approved yet: Application submitted": code in three places
-- treating 'applied' as the only proof that an application exists.
--
-- Waitlisting is a decision ABOUT a submitted application, not a reversal of
-- it. 'waitlist' is now accepted alongside 'applied'.
--
-- 'rejected' is deliberately still refused. That application was closed out and
-- the fee refunded; approving it without a fresh one would skip the decision.
--
-- Everything else in this function is byte-identical to migration 037. Only the
-- one status predicate changed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_easer_application_decision(
  p_assembler_id UUID,
  p_decision TEXT,
  p_operation_key TEXT,
  p_expected_snapshot JSONB
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
  v_decision TEXT := LOWER(BTRIM(COALESCE(p_decision, '')));
  v_operation_key TEXT := BTRIM(COALESCE(p_operation_key, ''));
  v_paid_mode BOOLEAN;
  v_waived_mode BOOLEAN;
BEGIN
  IF p_assembler_id IS NULL
     OR v_decision NOT IN ('approve', 'reject')
     OR v_operation_key = ''
     OR length(v_operation_key) > 240
     OR jsonb_typeof(p_expected_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid Easer application decision claim'
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

  IF v_decision = 'approve'
     AND v_profile.status = 'active'
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
  IF v_decision = 'reject'
     AND v_profile.status = 'rejected'
     AND v_profile.application_status = 'rejected'
     AND v_profile.application_decision_key IS NULL
     AND v_profile.application_fee_paid IS NOT TRUE
     AND v_profile.payment_confirmed IS NOT TRUE
     AND v_profile.application_fee_refunded IS NOT TRUE
     AND COALESCE(v_profile.application_fee_refunded_cents, 0) = 0
     AND COALESCE(v_profile.application_fee_refund_pending_cents, 0) = 0
     AND v_profile.application_fee_refund_review_required_at IS NULL
     AND v_profile.application_fee_refund_id IS NULL
     AND v_profile.application_fee_refunded_at IS NULL
     AND v_profile.stripe_payment_intent_id IS NULL THEN
    RETURN QUERY SELECT 'already_finalized'::TEXT, v_profile.status,
      v_profile.application_status, v_profile.application_fee_refund_id;
    RETURN;
  END IF;

  IF public.easer_application_decision_snapshot(v_profile)
       IS DISTINCT FROM p_expected_snapshot THEN
    RAISE EXCEPTION 'Easer profile state changed before the application decision claim'
      USING ERRCODE = '40001';
  END IF;

  IF v_profile.application_decision_key IS NOT NULL THEN
    IF v_profile.application_decision_type = v_decision
       AND v_profile.application_decision_key = v_operation_key THEN
      RETURN QUERY SELECT 'claimed'::TEXT, v_profile.status,
        v_profile.application_status, v_profile.application_fee_refund_id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Another Easer application decision is already in progress'
      USING ERRCODE = '55P03';
  END IF;

  IF v_decision = 'approve' THEN
    IF COALESCE(v_profile.status, 'pending') NOT IN ('pending', 'applied')
       OR v_profile.application_status NOT IN ('applied', 'waitlist')
       OR v_profile.application_fee_refunded IS TRUE
       OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
       OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
       OR v_profile.application_fee_refund_review_required_at IS NOT NULL THEN
      RAISE EXCEPTION 'Only a submitted pending application can be approved'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_profile.status = 'active'
       OR v_profile.application_status = 'approved' THEN
      RAISE EXCEPTION 'An active or approved Easer cannot be rejected'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.profiles
     SET application_decision_key = v_operation_key,
         application_decision_type = v_decision,
         application_decision_started_at = NOW()
   WHERE id = p_assembler_id;

  RETURN QUERY SELECT 'claimed'::TEXT, v_profile.status,
    v_profile.application_status, v_profile.application_fee_refund_id;
END;
$$;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (88, '088_approve_waitlisted_application')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT pg_get_functiondef(oid) LIKE '%application_status NOT IN (''applied'', ''waitlist'')%' AS accepts_waitlist
  FROM pg_proc WHERE proname = 'claim_easer_application_decision';
-- Expected: true.
