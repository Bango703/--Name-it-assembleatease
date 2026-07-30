-- ============================================================
-- Migration 042: Owner-Easer live flow on offline (owner_manual) bookings
--
-- The owner also holds a real, fully-onboarded Easer account and personally
-- performs some offline (owner_manual) jobs. For those jobs the owner wants to
-- run the FULL live Easer flow from the Easer app — Accept -> On the way ->
-- Arrived -> Start -> Complete — so the customer receives the same professional
-- status updates as any dispatched job and never sees that it was the owner.
-- Earnings are computed normally and the payout is recorded like a regular job.
--
-- Migration 040 allowed an Easer account to be LINKED to an already-completed
-- offline job (record-only) before a durable owner identity existed. This
-- migration tightens that historical allowance to the singular owner-Easer and
-- adds the LIVE flow: letting that same account be
-- assigned to and work a CONFIRMED (not-yet-finished) offline booking, whose
-- customer payment is collected by the owner offline and is therefore never
-- Stripe-authorized.
--
-- The allowance is deliberately as narrow as 040's:
--
--     NEW.source = 'owner_manual'
--     AND NEW.payment_status = 'offline_recorded'
--     AND the assigned profile has is_owner = TRUE
--
-- Nothing else changes:
--   * Online bookings still require Stripe authorized/deposit_paid to assign,
--     accept, or advance — even for the owner's own Easer account.
--   * A regular Easer (is_owner = FALSE) can never work or be credited with an
--     owner_manual booking.
--   * Readiness still applies to the live flow: the owner's Easer account must
--     be active, approved, identity-verified, agreement-signed, and available.
--   * The account-closure hold still applies to every case.
--
-- Apply AFTER migration 040. Safe to re-run.
-- ============================================================

BEGIN;

-- Column writes below go through the profile self-update guard (migration 031),
-- which bypasses for the service role via auth.role(). The Supabase SQL editor
-- has no auth context, so establish a transaction-local service-role claims
-- context (resets automatically at COMMIT).
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fail fast if the owner-manual foundation (migration 038/040) is not present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'bookings'
       AND column_name = 'source'
  ) THEN
    RAISE EXCEPTION 'Apply migration 038 (owner-manual booking columns) and 040 before migration 042';
  END IF;
END;
$$;

-- The single flag that marks the owner's own Easer account. Defaults FALSE, so
-- every existing and future Easer is a normal Easer until explicitly flagged.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- Identity is singular and role-bound. The self-update guard from migration 031
-- also treats this newly added field as protected because it compares every
-- column outside its explicit self-service allowlist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_single_owner_easer
  ON public.profiles (is_owner)
  WHERE is_owner IS TRUE;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_owner_easer_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_owner_easer_role_check
  CHECK (is_owner IS NOT TRUE OR role = 'assembler');

REVOKE INSERT (is_owner), UPDATE (is_owner)
  ON public.profiles
  FROM PUBLIC, anon, authenticated;

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
  v_owner_manual_easer BOOLEAN;
BEGIN
  IF NEW.assembler_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Load the assigned profile first: the owner-Easer allowance below depends on
  -- its is_owner flag, and the closure/readiness gates need it regardless.
  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = NEW.assembler_id
     AND role = 'assembler'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned Easer profile not found' USING ERRCODE = '23503';
  END IF;

  -- Allowance 1 (tightened migration 040 behavior): attributing an already-
  -- completed offline job to the singular owner-Easer account. No dispatch,
  -- live work, or Stripe money is implied.
  v_record_only_owner_manual := COALESCE(NEW.source, 'online') = 'owner_manual'
    AND NEW.status = 'completed'
    AND NEW.payment_status = 'offline_recorded'
    AND COALESCE(v_profile.is_owner, FALSE) = TRUE;

  -- Allowance 2 (this migration): the owner's own Easer account working the LIVE
  -- flow on an offline job. Payment is collected by the owner offline, so the
  -- Stripe payment gate cannot apply. Scoped to the canonical offline payment
  -- lane plus the singular owner-Easer identity.
  v_owner_manual_easer := COALESCE(NEW.source, 'online') = 'owner_manual'
    AND NEW.payment_status = 'offline_recorded'
    AND COALESCE(v_profile.is_owner, FALSE) = TRUE;

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

  -- The customer-payment gate is skipped for BOTH owner allowances. Everything
  -- else (online bookings, regular Easers) still requires verified payment.
  v_payment_guard_required := (
    v_assignment_started
    OR (
      TG_OP = 'UPDATE'
      AND NEW.status IS DISTINCT FROM OLD.status
      AND NEW.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')
    )
  ) AND NOT v_record_only_owner_manual AND NOT v_owner_manual_easer;

  -- Readiness is skipped only for the record-only link. The LIVE owner-Easer
  -- flow still requires a ready, approved, available Easer account.
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

  -- Closure hold still applies to every case, including both owner allowances.
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
    assignment_token, status, source, payment_status ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_booking_easer_closure_assignment();

REVOKE ALL ON FUNCTION public.guard_booking_easer_closure_assignment()
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (42, 'owner_easer_live_offline_flow')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
