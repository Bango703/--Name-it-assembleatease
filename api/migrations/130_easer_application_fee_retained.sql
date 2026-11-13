-- ============================================================
-- Migration 130: a non-refundable Easer application fee is kept on rejection
--
-- Owner, 2026-11-12: "when it comes to easer application form, its no refund."
-- New applicants accept non-refundable terms, stamped on their Stripe payment
-- (api/_easer-application-fee.js, consent version ...-nonrefundable-v2).
-- Rejecting such an application keeps the fee. Payments made under the old
-- terms ("refunded if rejected") are still refunded: that is what those
-- applicants agreed to, and api/assembler/update.js decides it per payment.
--
-- finalize_easer_application_decision (037) refused any paid rejection without
-- a full Stripe refund. It gains p_fee_retained (default FALSE, so every
-- existing call behaves exactly as before) and records the kept fee in
-- profiles.application_fee_retained_at, so a retried rejection is recognised.
-- The previous nine-argument signature is dropped so only one version exists.
-- ============================================================

BEGIN;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS application_fee_retained_at TIMESTAMPTZ;

DROP FUNCTION IF EXISTS public.finalize_easer_application_decision(
  UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.finalize_easer_application_decision(
  p_assembler_id UUID,
  p_decision TEXT,
  p_operation_key TEXT,
  p_expected_snapshot JSONB,
  p_required_agreement_version TEXT,
  p_refund_id TEXT DEFAULT NULL,
  p_refunded_at TIMESTAMPTZ DEFAULT NULL,
  p_rejection_reason TEXT DEFAULT NULL,
  p_decided_at TIMESTAMPTZ DEFAULT NULL,
  p_fee_retained BOOLEAN DEFAULT FALSE
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
  v_decided_at TIMESTAMPTZ := COALESCE(p_decided_at, NOW());
  v_refund_id TEXT := NULLIF(BTRIM(COALESCE(p_refund_id, '')), '');
BEGIN
  IF p_assembler_id IS NULL
     OR v_decision NOT IN ('approve', 'reject')
     OR v_operation_key = ''
     OR length(v_operation_key) > 240
     OR jsonb_typeof(p_expected_snapshot) IS DISTINCT FROM 'object'
     OR length(COALESCE(p_rejection_reason, '')) > 2000
     OR (COALESCE(p_fee_retained, FALSE) AND v_decision <> 'reject') THEN
    RAISE EXCEPTION 'Invalid Easer application decision finalization'
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
     AND v_profile.application_decision_key IS NULL
     AND v_profile.application_fee_refunded IS NOT TRUE
     AND COALESCE(v_profile.application_fee_refunded_cents, 0) = 0
     AND COALESCE(v_profile.application_fee_refund_pending_cents, 0) = 0
     AND v_profile.application_fee_refund_review_required_at IS NULL
     AND v_profile.application_fee_refund_id IS NULL
     AND v_profile.application_fee_refunded_at IS NULL THEN
    IF v_paid_mode = v_waived_mode
       OR (
         v_paid_mode
         AND (
           v_profile.stripe_payment_intent_id IS NULL
           OR v_profile.stripe_customer_id IS NULL
         )
       ) THEN
      RAISE EXCEPTION 'Finalized approval fee truth is inconsistent'
        USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT 'already_finalized'::TEXT, v_profile.status,
      v_profile.application_status, v_profile.application_fee_refund_id;
    RETURN;
  END IF;
  IF v_decision = 'reject'
     AND v_profile.status = 'rejected'
     AND v_profile.application_status = 'rejected'
     AND v_profile.application_decision_key IS NULL THEN
    IF v_refund_id IS DISTINCT FROM v_profile.application_fee_refund_id THEN
      RAISE EXCEPTION 'Finalized rejection refund truth does not match this retry'
        USING ERRCODE = '23514';
    END IF;
    IF v_refund_id IS NOT NULL THEN
      IF NOT v_paid_mode
         OR v_profile.application_fee_refunded IS NOT TRUE
         OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 3000
         OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
         OR v_profile.application_fee_refund_review_required_at IS NULL
         OR v_profile.application_fee_refunded_at IS NULL
         OR v_profile.stripe_payment_intent_id IS NULL
         OR v_profile.stripe_customer_id IS NULL THEN
        RAISE EXCEPTION 'Finalized paid rejection refund truth is inconsistent'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_profile.application_fee_retained_at IS NOT NULL THEN
      -- Rejected with the non-refundable fee kept (migration 130).
      IF NOT v_paid_mode
         OR v_profile.application_fee_refunded IS TRUE
         OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
         OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
         OR v_profile.application_fee_refund_id IS NOT NULL
         OR v_profile.application_fee_refunded_at IS NOT NULL
         OR v_profile.stripe_payment_intent_id IS NULL
         OR v_profile.stripe_customer_id IS NULL THEN
        RAISE EXCEPTION 'Finalized rejection with a retained fee is inconsistent'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_profile.application_fee_paid IS TRUE
       OR v_profile.payment_confirmed IS TRUE
       OR v_profile.application_fee_refunded IS TRUE
       OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
       OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
       OR v_profile.application_fee_refund_review_required_at IS NOT NULL
       OR v_profile.application_fee_refunded_at IS NOT NULL THEN
      RAISE EXCEPTION 'Finalized rejection contains unresolved payment or refund truth'
        USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT 'already_finalized'::TEXT, v_profile.status,
      v_profile.application_status, v_profile.application_fee_refund_id;
    RETURN;
  END IF;

  IF v_profile.application_decision_type IS DISTINCT FROM v_decision
     OR v_profile.application_decision_key IS DISTINCT FROM v_operation_key THEN
    RAISE EXCEPTION 'The exact Easer application decision claim is not held'
      USING ERRCODE = '55P03';
  END IF;
  IF public.easer_application_decision_snapshot(v_profile)
       IS DISTINCT FROM p_expected_snapshot THEN
    RAISE EXCEPTION 'Easer profile state changed before application decision finalization'
      USING ERRCODE = '40001';
  END IF;

  IF v_decision = 'approve' THEN
    IF NULLIF(BTRIM(COALESCE(p_required_agreement_version, '')), '') IS NULL
       OR v_profile.application_status IS DISTINCT FROM 'applied'
       OR COALESCE(v_profile.status, 'pending') NOT IN ('pending', 'applied')
       OR v_profile.identity_verified IS NOT TRUE
       OR v_profile.contractor_agreement_signed_at IS NULL
       OR v_profile.contractor_agreement_version IS DISTINCT FROM p_required_agreement_version
       OR v_profile.code_of_conduct_agreed_at IS NULL
       OR NULLIF(BTRIM(COALESCE(v_profile.phone, '')), '') IS NULL
       OR COALESCE(v_profile.account_closure_status, '') IN ('requested', 'reviewing', 'completed') THEN
      RAISE EXCEPTION 'Easer readiness changed before approval finalization'
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
       OR v_profile.application_fee_refunded_at IS NOT NULL
       OR v_refund_id IS NOT NULL
       OR p_refunded_at IS NOT NULL THEN
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
  ELSE
    IF v_profile.status = 'active'
       OR v_profile.application_status = 'approved' THEN
      RAISE EXCEPTION 'An active or approved Easer cannot be rejected'
        USING ERRCODE = '23514';
    END IF;
    IF v_paid_mode AND COALESCE(p_fee_retained, FALSE) THEN
      -- Non-refundable fee kept: no refund may exist anywhere.
      IF v_refund_id IS NOT NULL
         OR p_refunded_at IS NOT NULL
         OR v_profile.stripe_payment_intent_id IS NULL
         OR v_profile.stripe_customer_id IS NULL
         OR v_profile.application_fee_refunded IS TRUE
         OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
         OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
         OR v_profile.application_fee_refund_review_required_at IS NOT NULL
         OR v_profile.application_fee_refund_id IS NOT NULL
         OR v_profile.application_fee_refunded_at IS NOT NULL THEN
        RAISE EXCEPTION 'A retained application fee cannot carry refund activity'
          USING ERRCODE = '23514';
      END IF;
    ELSIF COALESCE(p_fee_retained, FALSE) THEN
      RAISE EXCEPTION 'Only a paid application fee can be retained'
        USING ERRCODE = '23514';
    ELSIF v_paid_mode THEN
      IF v_refund_id IS NULL
         OR p_refunded_at IS NULL
         OR v_profile.stripe_payment_intent_id IS NULL
         OR v_profile.stripe_customer_id IS NULL
         OR v_profile.application_fee_refunded IS NOT TRUE
         OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 3000
         OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
         OR v_profile.application_fee_refund_review_required_at IS NULL
         OR v_profile.application_fee_refund_id IS DISTINCT FROM v_refund_id
         OR v_profile.application_fee_refunded_at IS NULL THEN
        RAISE EXCEPTION 'Paid application rejection requires a completed aggregate Stripe refund'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_profile.application_fee_paid IS TRUE
       OR v_profile.payment_confirmed IS TRUE
       OR v_profile.application_fee_refunded IS TRUE
       OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
       OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
       OR v_profile.application_fee_refund_review_required_at IS NOT NULL
       OR v_profile.application_fee_refund_id IS NOT NULL
       OR v_profile.application_fee_refunded_at IS NOT NULL
       OR v_refund_id IS NOT NULL
       OR p_refunded_at IS NOT NULL THEN
      RAISE EXCEPTION 'An unpaid or waived application cannot persist a refund'
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.profiles
       SET status = 'rejected',
           application_status = 'rejected',
           tier = NULL,
           previous_tier = NULL,
           is_available = FALSE,
           rejected_at = COALESCE(rejected_at, v_decided_at),
           rejection_reason = NULLIF(BTRIM(COALESCE(p_rejection_reason, '')), ''),
           application_fee_retained_at = CASE
             WHEN v_paid_mode AND COALESCE(p_fee_retained, FALSE) THEN v_decided_at
             ELSE application_fee_retained_at END,
           application_decision_key = NULL,
           application_decision_type = NULL,
           application_decision_started_at = NULL
     WHERE id = p_assembler_id;
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = p_assembler_id;
  RETURN QUERY SELECT 'applied'::TEXT, v_profile.status,
    v_profile.application_status, v_profile.application_fee_refund_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_easer_application_decision(
  UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_easer_application_decision(
  UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, BOOLEAN
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (130, 'easer_application_fee_retained')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
