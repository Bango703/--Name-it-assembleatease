-- Migration 108: a requested profile photo blocks job offers until it is uploaded.
--
-- Owner, 2026-10-09: requesting a new photo from an Easer only cleared the photo
-- and sent an email. The Easer stayed online, the app said nothing, and the
-- owner expected what Uber does: the Easer goes offline and the app shows the
-- one thing needed.
--
-- 1. profiles.profile_photo_requested_at / profile_photo_request_note, set by
--    the owner's "Request new photo" (api/assembler/update.js request_photo)
--    and read by readiness (api/_easer-readiness.js) as a missing item, so
--    dispatch, assign, Live Ops and the online switch all refuse until done.
-- 2. Uploading a new photo clears the request in the database, whichever path
--    saves it. The trigger sorts after profiles_guard_self_update, so the
--    Easer's own update still passes that guard first.
-- 3. The assignment trigger refuses an Easer with an open photo request
--    (migration 107's body plus that one line), so the database and the API
--    agree (scripts/test-readiness-db-parity.mjs).
--
-- Easers cannot set or clear the request themselves: guard_profile_self_update
-- (migration 031) allows only an explicit list of fields.
--
-- Apply BEFORE deploying the code: readiness reads these columns.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS profile_photo_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS profile_photo_request_note TEXT;

CREATE OR REPLACE FUNCTION public.clear_profile_photo_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.profile_photo_requested_at IS NOT NULL
     AND NEW.profile_photo IS NOT NULL
     AND NEW.profile_photo IS DISTINCT FROM OLD.profile_photo THEN
    NEW.profile_photo_requested_at := NULL;
    NEW.profile_photo_request_note := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_zz_clear_photo_request ON public.profiles;
CREATE TRIGGER profiles_zz_clear_photo_request
  BEFORE UPDATE OF profile_photo ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_profile_photo_request();

REVOKE ALL ON FUNCTION public.clear_profile_photo_request() FROM PUBLIC, anon, authenticated;

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
       OR v_profile.profile_photo_requested_at IS NOT NULL
       OR COALESCE(v_profile.account_closure_status, '') IN ('requested', 'reviewing', 'completed') THEN
      RAISE EXCEPTION 'Assigned Easer is not ready and eligible for jobs'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (108, 'profile_photo_request')
ON CONFLICT (migration_number) DO NOTHING;

NOTIFY pgrst, 'reload schema';
