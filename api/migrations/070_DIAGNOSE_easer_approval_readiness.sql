-- ============================================================
-- Read-only. Changes nothing.
--
-- "Why is this Easer still Pending Review?" — this shows every gate the server
-- checks in getEaserApprovalReadiness() (api/_easer-readiness.js), so the answer
-- is a row of PASS/FAIL rather than a guess.
--
-- IMPORTANT: 'Pending Review' is profiles.status = 'pending', and it is BY
-- DESIGN. The platform never auto-approves. Identity verification does not
-- activate anyone — the owner must click Approve. If every gate below is met,
-- there is no bug: the account is simply waiting on you.
--
-- Change the name below to check anyone else.
-- ============================================================

SELECT
  full_name,
  email,
  created_at,

  -- What the owner dashboard shows in the Easers table.
  status                                   AS account_status_badge,
  application_status,

  -- Gate 1: application actually submitted (fee flow completed).
  -- MUST be 'applied'. If it still reads 'payment_pending', the Stripe
  -- application-fee confirmation never finalized — the owner dashboard will
  -- still OFFER an Approve button, but the server will refuse it with
  -- EASER_NOT_READY / "Application submitted".
  (application_status = 'applied')          AS gate1_application_submitted,

  -- Gate 2: identity verified.
  (identity_verified IS TRUE)               AS gate2_identity_verified,

  -- Gate 3: application fee satisfied — paid XOR waived, never both, never
  -- neither. The server treats an inconsistent combination as unapprovable.
  (
    (application_fee_paid IS TRUE
      AND payment_confirmed IS TRUE
      AND application_fee_waived IS NOT TRUE
      AND fee_waived_by_owner IS NOT TRUE)
    <>
    (application_fee_paid IS NOT TRUE
      AND payment_confirmed IS NOT TRUE
      AND (application_fee_waived IS TRUE OR fee_waived_by_owner IS TRUE))
  )                                         AS gate3_fee_paid_xor_waived,

  -- Gate 4: no refund/dispute hold on the application fee.
  (
    application_fee_refunded IS NOT TRUE
    AND COALESCE(application_fee_refunded_cents, 0) = 0
    AND COALESCE(application_fee_refund_pending_cents, 0) = 0
    AND application_fee_refund_review_required_at IS NULL
  )                                         AS gate4_no_refund_hold,

  -- Gate 5: no account-closure request blocking approval.
  COALESCE(account_closure_status, 'none')  AS gate5_closure_status,

  -- Plain-English verdict, so the answer does not need interpreting.
  CASE
    WHEN application_status <> 'applied'
      THEN 'BLOCKED: application never finalized (still ' || COALESCE(application_status, 'null') || ')'
    WHEN identity_verified IS NOT TRUE
      THEN 'BLOCKED: identity not verified'
    WHEN application_fee_refunded IS TRUE
      OR COALESCE(application_fee_refunded_cents, 0) > 0
      OR COALESCE(application_fee_refund_pending_cents, 0) > 0
      OR application_fee_refund_review_required_at IS NOT NULL
      THEN 'BLOCKED: application-fee REFUND HOLD — needs reconcile_application_fee_hold (no owner button exists for this yet)'
    WHEN application_fee_paid IS TRUE AND (application_fee_waived IS TRUE OR fee_waived_by_owner IS TRUE)
      THEN 'BLOCKED: fee marked BOTH paid and waived — contradictory, must be one or the other'
    WHEN application_fee_paid IS TRUE AND payment_confirmed IS NOT TRUE
      THEN 'BLOCKED: fee paid but payment_confirmed is not true — half-written payment state'
    WHEN application_fee_paid IS NOT TRUE
      AND application_fee_waived IS NOT TRUE
      AND fee_waived_by_owner IS NOT TRUE
      THEN 'BLOCKED: fee neither paid nor waived'
    WHEN (application_fee_waived IS TRUE OR fee_waived_by_owner IS TRUE) AND payment_confirmed IS TRUE
      THEN 'BLOCKED: waived but payment_confirmed is true — the waive XOR check rejects this combination'
    ELSE 'APPROVABLE: every gate met — click Approve in the dashboard'
  END                                       AS verdict,

  -- Supporting detail for whichever gate failed.
  application_fee_paid,
  payment_confirmed,
  application_fee_waived,
  fee_waived_by_owner,
  application_fee_refunded,
  application_fee_refunded_cents,
  application_fee_refund_pending_cents,
  application_fee_refund_review_required_at,
  application_fee_refund_review_reason,
  stripe_payment_intent_id,
  stripe_customer_id,
  id_verification_status

FROM public.profiles
WHERE role = 'assembler'
  AND full_name ILIKE '%trapper%'
ORDER BY created_at DESC;
