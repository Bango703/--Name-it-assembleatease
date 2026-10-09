-- Migration 107: a demo Easer (App Store review) can run a whole test job.
--
-- Migration 106 marked the App Review account is_demo_account and the API now
-- refuses it on any real booking. But a reviewer still could not work a job:
-- the only booking that carries no customer card is an owner-created offline
-- booking, and the payment guard below lets only the owner's own Easer account
-- work one of those. Every other Easer needs a Stripe hold, which a test job
-- does not have and must not have.
--
-- This body is migration 095's, verified identical to production on 2026-10-09
-- (md5 of the comment- and whitespace-normalized source matched), with three
-- changes and nothing else:
--
--   1. Allowance 3: a demo account on an offline TEST booking skips the
--      customer-payment gate, exactly as the owner-Easer does on an offline
--      booking. Readiness, closure and every other check still apply.
--   2. A demo account can never be assigned to, or accept, a booking that is
--      not a test booking (the database half of api/_demo-accounts.js).
--   3. Nothing else. The agreement-version check still reads
--      public.current_required_agreement_version() (see 091 and 095).
--
-- Completion of a demo test job records no payout obligation
-- (api/booking/assembler-complete.js), and test bookings are excluded from
-- payouts owed (api/owner/payouts.js).

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
  v_demo_test_easer BOOLEAN;
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

  -- Allowance 3 (migration 107): a DEMO Easer account (App Store review) working
  -- the same live flow on an offline booking the owner marked as a TEST. No
  -- customer, card or Stripe money exists on such a booking.
  v_demo_test_easer := COALESCE(NEW.source, 'online') = 'owner_manual'
    AND NEW.payment_status = 'offline_recorded'
    AND COALESCE(NEW.is_test_booking, FALSE) = TRUE
    AND COALESCE(v_profile.is_demo_account, FALSE) = TRUE;

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

  -- A demo account is never put on, and never accepts, a real booking. The API
  -- refuses this first (api/_demo-accounts.js); this is the database half.
  IF v_assignment_started
     AND COALESCE(v_profile.is_demo_account, FALSE) = TRUE
     AND COALESCE(NEW.is_test_booking, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'A demo account can only be given test bookings'
      USING ERRCODE = '23514';
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
  ) AND NOT v_record_only_owner_manual AND NOT v_owner_manual_easer AND NOT v_demo_test_easer;

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
VALUES (107, 'demo_test_job_flow')
ON CONFLICT (migration_number) DO NOTHING;

NOTIFY pgrst, 'reload schema';
