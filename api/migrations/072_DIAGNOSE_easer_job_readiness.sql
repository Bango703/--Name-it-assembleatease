-- ============================================================
-- Read-only. Changes nothing.
--
-- "The Easer shows Available but I can't dispatch or assign them."
--
-- Both dispatch and manual assign call getEaserReadiness() and drop anyone whose
-- isReady is false — api/booking/assemblers.js line 51 does `continue`, so a
-- not-ready Easer simply VANISHES from the assign dropdown with no reason shown.
-- The owner dashboard's Job Readiness panel does not display all of the gates,
-- so the blocking one can be invisible.
--
-- This reproduces every gate in api/_easer-readiness.js. The FIRST column that
-- reads false is your blocker.
--
-- Note: "Available" in the Easer Availability widget only reflects is_available.
-- It is one gate out of nine.
-- ============================================================

SELECT
  full_name,

  -- ALL NINE GATES. Every one must be true for dispatch or assignment.
  (contractor_agreement_signed_at IS NOT NULL)          AS agreement_accepted,
  (contractor_agreement_signed_at IS NOT NULL
     AND contractor_agreement_version = '2026-08-16')   AS agreement_current,
  (code_of_conduct_agreed_at IS NOT NULL)               AS code_of_conduct_accepted,
  (identity_verified IS TRUE)                           AS identity_verified,
  (status = 'active' AND application_status = 'approved') AS owner_approved,
  (tier IN ('starter', 'professional', 'elite'))        AS tier_eligible,
  (is_available IS TRUE)                                AS online_and_available,
  (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^1?[0-9]{10}$') AS phone_valid,
  (
    application_fee_refunded IS NOT TRUE
    AND COALESCE(application_fee_refunded_cents, 0) = 0
    AND COALESCE(application_fee_refund_pending_cents, 0) = 0
    AND application_fee_refund_review_required_at IS NULL
    AND (application_fee_paid IS TRUE
         OR application_fee_waived IS TRUE
         OR fee_waived_by_owner IS TRUE)
  )                                                     AS application_fee_satisfied,
  (COALESCE(account_closure_status, '') NOT IN ('requested', 'reviewing', 'completed'))
                                                        AS no_closure_block,

  -- Names the first failing gate outright.
  CASE
    WHEN contractor_agreement_signed_at IS NULL              THEN 'BLOCKED: contractor agreement not accepted'
    WHEN contractor_agreement_version IS DISTINCT FROM '2026-08-16'
      THEN 'BLOCKED: agreement version is ' || COALESCE(contractor_agreement_version, 'null') || ', current is 2026-08-16 — must re-accept'
    WHEN code_of_conduct_agreed_at IS NULL                   THEN 'BLOCKED: code of conduct not accepted (NOT shown in the Job Readiness panel)'
    WHEN identity_verified IS NOT TRUE                       THEN 'BLOCKED: identity not verified'
    WHEN status IS DISTINCT FROM 'active'                    THEN 'BLOCKED: status is ' || COALESCE(status, 'null') || ', must be active'
    WHEN application_status IS DISTINCT FROM 'approved'      THEN 'BLOCKED: application_status is ' || COALESCE(application_status, 'null') || ', must be approved'
    WHEN tier NOT IN ('starter', 'professional', 'elite')    THEN 'BLOCKED: tier is ' || COALESCE(tier, 'null')
    WHEN is_available IS NOT TRUE                            THEN 'BLOCKED: not Online (is_available is not true)'
    WHEN regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') !~ '^1?[0-9]{10}$'
      THEN 'BLOCKED: phone is not a valid 10-digit US number (' || COALESCE(phone, 'null') || ') — NOT shown in the Job Readiness panel'
    WHEN NOT (application_fee_refunded IS NOT TRUE
      AND COALESCE(application_fee_refunded_cents, 0) = 0
      AND COALESCE(application_fee_refund_pending_cents, 0) = 0
      AND application_fee_refund_review_required_at IS NULL
      AND (application_fee_paid IS TRUE OR application_fee_waived IS TRUE OR fee_waived_by_owner IS TRUE))
      THEN 'BLOCKED: application fee not satisfied — NOT shown in the Job Readiness panel'
    WHEN COALESCE(account_closure_status, '') IN ('requested', 'reviewing', 'completed')
      THEN 'BLOCKED: account closure ' || account_closure_status
    ELSE 'READY — this Easer can be dispatched and assigned'
  END                                                   AS verdict,

  -- Raw values behind whichever gate failed.
  status, application_status, tier, is_available, phone,
  contractor_agreement_version, code_of_conduct_agreed_at, identity_verified,
  application_fee_paid, application_fee_waived, fee_waived_by_owner,
  city, zip

FROM public.profiles
WHERE role = 'assembler'
  AND COALESCE(status, '') <> 'rejected'
ORDER BY full_name;
