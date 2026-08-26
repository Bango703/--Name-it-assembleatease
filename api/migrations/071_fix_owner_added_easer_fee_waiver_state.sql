-- ============================================================
-- Migration 071: Repair owner-added Easers stuck un-approvable
--
-- SYMPTOM (live, blocking): an Easer added through the owner dashboard's
-- "Add Easer — Fee Waived" modal shows PENDING REVIEW with every Job Readiness
-- item green except "Owner Approved", and the Approve button is permanently
-- greyed out. There is no error and no way forward from the UI.
--
-- CAUSE: api/owner/add-easer.js wrote a fee state that the approval check
-- treats as contradictory. Approval requires the fee to be paid XOR waived:
--
--   paidMode   = fee_paid && payment_confirmed && !waived && !waived_by_owner
--   waivedMode = !fee_paid && !payment_confirmed && (waived || waived_by_owner)
--   satisfied  = (paidMode XOR waivedMode) && no refund hold
--
-- add-easer.js wrote payment_confirmed = TRUE together with
-- fee_waived_by_owner = TRUE and application_fee_paid = FALSE. That makes
-- paidMode false (not paid) AND waivedMode false (payment_confirmed is true),
-- so the XOR yields false and the Easer can never be approved. The same logic
-- runs in the browser (easerApprovalFeeSatisfied) and on the server
-- (getEaserApprovalReadiness), so the button greys out AND the API would
-- refuse — a genuine dead end, not a display bug.
--
-- payment_confirmed = FALSE is the truthful value for a waived fee: no payment
-- was ever taken, so no payment was ever confirmed.
--
-- Also repairs profiles.status, which add-easer.js never set at all. The owner
-- dashboard hid this by deriving a display status from `tier`, and the approval
-- RPC COALESCEs NULL to 'pending', so it never surfaced — but a NULL status is
-- invisible to every server query that filters .eq('status', 'pending'),
-- including the dashboard's own Pending tab.
--
-- SCOPE: only owner-waived, not-yet-approved applicants. Rows where the fee was
-- genuinely PAID are never touched — this must not rewrite real payment truth.
-- Safe to re-run.
--
-- RUNNING THIS: profiles carries the profiles_guard_self_update trigger from
-- migration 031, which rejects any UPDATE that is not from the service role
-- ("Profile ownership is required", SQLSTATE 42501). That guard is correct and
-- stays in place — it is what stops an Easer editing their own tier, status, or
-- fee flags. The SQL editor simply carries no JWT claim, so the trigger sees an
-- anonymous writer.
--
-- Step 0 below declares the service-role claim for THIS TRANSACTION ONLY, which
-- is the same identity the server's own admin client uses. It is transaction-
-- local (set_config's third argument is true), so it reverts automatically on
-- commit, rollback, or error — the trigger is never disabled, and no window
-- exists where anyone else's writes are unguarded. Disabling the trigger
-- instead would leave it off if this script failed partway.
-- ============================================================

-- 0) Identify this transaction as the service role, exactly as the application's
--    admin client does. Reverts on its own; nothing is left loosened.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- 1) Show what will change, before changing it.
DO $$
DECLARE
  v_fee INTEGER;
  v_status INTEGER;
BEGIN
  SELECT count(*) INTO v_fee
    FROM public.profiles
   WHERE role = 'assembler'
     AND application_status = 'applied'
     AND application_fee_paid IS NOT TRUE
     AND payment_confirmed IS TRUE
     AND (application_fee_waived IS TRUE OR fee_waived_by_owner IS TRUE)
     AND application_fee_refunded IS NOT TRUE
     AND COALESCE(application_fee_refunded_cents, 0) = 0
     AND COALESCE(application_fee_refund_pending_cents, 0) = 0;

  SELECT count(*) INTO v_status
    FROM public.profiles
   WHERE role = 'assembler'
     AND status IS NULL;

  RAISE NOTICE 'migration 071: clearing payment_confirmed on % owner-waived applicant(s); setting status on % row(s) with a NULL status', v_fee, v_status;
END;
$$;

-- 2) Clear the contradictory payment_confirmed flag on owner-waived applicants.
--    The guards are deliberately tight: application_fee_paid must NOT be true
--    (so a real payment is never rewritten), a waiver must actually be on the
--    row, and there must be no refund activity to reconcile first.
UPDATE public.profiles
   SET payment_confirmed = FALSE
 WHERE role = 'assembler'
   AND application_status = 'applied'
   AND application_fee_paid IS NOT TRUE
   AND payment_confirmed IS TRUE
   AND (application_fee_waived IS TRUE OR fee_waived_by_owner IS TRUE)
   AND application_fee_refunded IS NOT TRUE
   AND COALESCE(application_fee_refunded_cents, 0) = 0
   AND COALESCE(application_fee_refund_pending_cents, 0) = 0
   AND application_fee_refund_review_required_at IS NULL;

-- 3) Give NULL-status Easer rows an explicit status. 'active' is inferred only
--    where the application is already approved; everything else is 'pending',
--    matching what the approval RPC already assumes via COALESCE.
UPDATE public.profiles
   SET status = CASE WHEN application_status = 'approved' THEN 'active' ELSE 'pending' END
 WHERE role = 'assembler'
   AND status IS NULL;

-- 4) Confirm the repair: every owner-waived applicant should now satisfy the
--    paid-XOR-waived rule the Approve button checks.
DO $$
DECLARE
  v_stuck INTEGER;
BEGIN
  SELECT count(*) INTO v_stuck
    FROM public.profiles
   WHERE role = 'assembler'
     AND application_status = 'applied'
     AND status = 'pending'
     AND NOT (
       (application_fee_paid IS TRUE
         AND payment_confirmed IS TRUE
         AND application_fee_waived IS NOT TRUE
         AND fee_waived_by_owner IS NOT TRUE)
       <>
       (application_fee_paid IS NOT TRUE
         AND payment_confirmed IS NOT TRUE
         AND (application_fee_waived IS TRUE OR fee_waived_by_owner IS TRUE))
     );
  IF v_stuck > 0 THEN
    RAISE NOTICE 'migration 071: % applicant(s) still fail the fee check — run 070_DIAGNOSE to see why (likely a real refund hold, which this migration deliberately does not clear)', v_stuck;
  ELSE
    RAISE NOTICE 'migration 071: all pending applicants now satisfy the application-fee check';
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (71, '071_fix_owner_added_easer_fee_waiver_state')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$$;

-- 5) Prove the guard is still armed. This must report ENABLED — if it ever
--    reports otherwise, the trigger was disabled somewhere and Easers could
--    edit their own status, tier, and fee flags.
SELECT tgname AS trigger_name,
       CASE tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED — INVESTIGATE' ELSE tgenabled::text END AS state
  FROM pg_trigger
 WHERE tgrelid = 'public.profiles'::regclass
   AND tgname = 'profiles_guard_self_update';
