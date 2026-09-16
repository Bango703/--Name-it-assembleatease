-- Migration 095: let a confirmed saved card carry an assignment.
--
-- A booking taken more than about a week out is written payment_status
-- 'card_saved': the customer's card is confirmed and on file, and the Stripe
-- hold is deliberately deferred to five days before the visit, because an
-- authorization only survives seven days.
--
-- The trigger's payment guard accepted only 'authorized' and 'deposit_paid' and
-- raised 'Customer payment must be verified before assignment or acceptance'
-- for everything else. So no advance booking could have an Easer attached until
-- five days before the job. AAE-DVSNHXE4OO (Sep 24) could not be staffed until
-- Sep 19, while its confirmation email had already told the customer that "a pro
-- has already reserved the time".
--
-- Worse, that exception raises ERRCODE 23514, which api/booking/assign.js
-- classifies as a readiness conflict -- so the owner was shown "The booking or
-- Easer readiness changed before assignment", blaming a pro whose account was
-- perfectly healthy.
--
-- PR #163 opened the application-side gate for this case. This migration is the
-- half that lives in the database (Article 7): without it the API permits the
-- assignment and the trigger still rejects it.
--
-- NOTE: this body is migration 042's, with two changes. The agreement-version
-- check reads public.current_required_agreement_version() rather than the
-- literal 042 pinned, because migration 091 rewrote that check in place and
-- re-pinning it here would silently undo 091 and lock out every Easer holding
-- the CURRENT agreement. check-agreement-version-hardcoding.mjs enforces this.
--
-- A saved card may now STAFF a job. It may NOT start live work: transitions to
-- en_route/arrived/in_progress still require the hold, and completion/capture
-- remain gated independently in api/booking/assembler-complete.js. Every other
-- branch of this function is unchanged from migration 042.

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
  v_live_work_transition BOOLEAN;
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

  -- Staffing a job is not the same act as starting it. A booking taken far in
  -- advance carries a CONFIRMED saved card whose Stripe hold is deliberately
  -- deferred to a few days before the visit, so requiring the hold at ASSIGNMENT
  -- meant no advance booking could be staffed until the last minute. Beginning
  -- live work is different and still requires the hold.
  v_live_work_transition := TG_OP = 'UPDATE'
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('en_route', 'arrived', 'in_progress');

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
    ELSIF NEW.payment_status = 'card_saved' THEN
      -- A saved card is a CONFIRMED payment method awaiting its scheduled hold,
      -- unlike 'pending', 'failed' or 'not_required'. It may carry an
      -- assignment so the owner can line up supply; it may never carry the
      -- start of live work, and capture is gated separately in the API.
      IF v_live_work_transition THEN
        RAISE EXCEPTION 'Customer payment must be authorized before work begins'
          USING ERRCODE = '23514';
      ELSIF NEW.stripe_payment_method_id IS NULL THEN
        RAISE EXCEPTION 'Saved-card assignment requires its saved Stripe payment method'
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
       OR v_profile.contractor_agreement_version IS DISTINCT FROM
            COALESCE(public.current_required_agreement_version(), '2026-08-16')
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
VALUES (95, 'saved_card_may_carry_assignment')
ON CONFLICT (migration_number) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   An advance booking (payment_status 'card_saved', stripe_payment_method_id
--   present) accepts an assembler_id.
--   The same booking still refuses a transition to en_route.
--   A 'pending' or 'failed' booking still refuses assignment.
