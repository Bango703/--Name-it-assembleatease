-- ============================================================
-- Migration 120: Thumbtack external bookings
--
-- Records Thumbtack agreement and payment truth separately from AAE Terms and
-- Stripe. Assignment keeps all Easer-readiness checks; payouts stay held until
-- the exact external deposit and its reference are recorded.
-- Safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS external_platform TEXT,
  ADD COLUMN IF NOT EXISTS external_agreement_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_payment_reference TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_external_platform_supported') THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_external_platform_supported
      CHECK (external_platform IS NULL OR external_platform = 'thumbtack');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_thumbtack_external_truth') THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_thumbtack_external_truth
      CHECK (
        (external_platform = 'thumbtack'
          AND payment_method = 'thumbtack'
          AND external_agreement_verified_at IS NOT NULL)
        OR (external_platform IS NULL AND payment_method IS DISTINCT FROM 'thumbtack')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_thumbtack_collection_reference') THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_thumbtack_collection_reference
      CHECK (payment_method IS DISTINCT FROM 'thumbtack'
        OR payment_collected IS NOT TRUE
        OR NULLIF(BTRIM(external_payment_reference), '') IS NOT NULL);
  END IF;
END;
$$;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payment_method_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN (
    'stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice', 'mixed', 'thumbtack'
  ));

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

  -- Allowance 2: the owner's own Easer account working an offline owner job,
  -- or a verified Thumbtack booking assigned to a real (non-demo) ready Easer.
  -- The Thumbtack case records external agreement separately from AAE Terms.
  -- Payout stays blocked until external collection is verified by the owner.
  v_owner_manual_easer := COALESCE(NEW.source, 'online') = 'owner_manual'
    AND NEW.payment_status = 'offline_recorded'
    AND (
      COALESCE(v_profile.is_owner, FALSE) = TRUE
      OR (
        NEW.payment_method = 'thumbtack'
        AND NEW.external_platform = 'thumbtack'
        AND NEW.external_agreement_verified_at IS NOT NULL
        AND COALESCE(v_profile.is_demo_account, FALSE) IS NOT TRUE
      )
    );

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
CREATE OR REPLACE FUNCTION public.record_booking_payout(
  p_booking_id UUID,
  p_payout_amount_cents INTEGER,
  p_notes TEXT DEFAULT NULL,
  p_recorded_by TEXT DEFAULT 'owner',
  p_payout_method TEXT DEFAULT 'manual'
)
RETURNS TABLE (
  booking_id UUID,
  booking_ref TEXT,
  assembler_id UUID,
  assembler_name TEXT,
  assembler_tier TEXT,
  payout_amount INTEGER,
  platform_revenue INTEGER,
  amount_charged INTEGER,
  assembler_due INTEGER,
  recorded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  booking_row public.bookings%ROWTYPE;
  canonical_due_cents INTEGER;
  v_reimbursement_cents INTEGER := 0;
  amount_charged_cents INTEGER;
  net_captured_cents INTEGER;
  remaining_tax_cents INTEGER;
  stripe_fee_cents INTEGER;
  platform_revenue_cents INTEGER;
  expected_operation_key TEXT;
  normalized_method TEXT := LOWER(COALESCE(NULLIF(BTRIM(p_payout_method), ''), 'manual'));
  verified_offline_collection BOOLEAN;
  current_payout_status TEXT;
BEGIN
  SELECT * INTO booking_row FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  expected_operation_key := 'payout:manual:' || booking_row.id::TEXT;
  IF booking_row.financial_operation_type IS DISTINCT FROM 'payout_manual'
     OR booking_row.financial_operation_key IS DISTINCT FROM expected_operation_key THEN
    RAISE EXCEPTION 'Manual payout does not hold the booking payout reservation' USING ERRCODE = '55P03';
  END IF;
  IF booking_row.financial_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'Financial reconciliation must be completed before payout' USING ERRCODE = '22000';
  END IF;
  IF booking_row.payout_mode_snapshot IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'This earning is assigned to the Stripe Connect payout path' USING ERRCODE = '22000';
  END IF;
  IF booking_row.damage_review_status = 'review_required' THEN
    RAISE EXCEPTION 'An open damage review must be resolved before payout' USING ERRCODE = '22000';
  END IF;
  IF booking_row.damage_review_status = 'resolved'
     AND (
       booking_row.damage_claim_opened_at IS NULL
       OR booking_row.damage_reviewed_at IS NULL
       OR COALESCE(BTRIM(booking_row.damage_reviewed_by), '') = ''
       OR CHAR_LENGTH(BTRIM(COALESCE(booking_row.damage_review_notes, ''))) < 10
     ) THEN
    RAISE EXCEPTION 'The damage review record is incomplete' USING ERRCODE = '22000';
  END IF;
  IF booking_row.stripe_dispute_hold IS TRUE
     OR (
       booking_row.stripe_dispute_id IS NOT NULL
       AND LOWER(COALESCE(booking_row.stripe_dispute_status, '')) NOT IN ('won', 'warning_closed', 'prevented')
     ) THEN
    RAISE EXCEPTION 'A Stripe dispute hold must be resolved before payout' USING ERRCODE = '22000';
  END IF;
  IF normalized_method NOT IN ('manual', 'ach', 'zelle', 'paypal', 'check') THEN
    RAISE EXCEPTION 'Unsupported manual payout method: %', normalized_method USING ERRCODE = '22000';
  END IF;

  current_payout_status := CASE
    WHEN booking_row.status = 'cancelled'
      THEN COALESCE(booking_row.cancellation_easer_payout_status, booking_row.payout_status)
    ELSE booking_row.payout_status
  END;
  IF current_payout_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Payout state must be pending before payment can be recorded. Current state: %',
      current_payout_status USING ERRCODE = '22000';
  END IF;

  verified_offline_collection := booking_row.source = 'owner_manual'
    AND booking_row.payment_status = 'offline_recorded'
    AND booking_row.payment_collected IS TRUE
    AND booking_row.payment_collected_at IS NOT NULL
    AND COALESCE(BTRIM(booking_row.payment_collected_by), '') <> ''
    AND LOWER(COALESCE(BTRIM(booking_row.payment_method), '')) IN (
      'stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice', 'thumbtack'
    )
    AND (booking_row.payment_method <> 'thumbtack'
      OR (booking_row.external_platform = 'thumbtack'
        AND NULLIF(BTRIM(booking_row.external_payment_reference), '') IS NOT NULL))
    AND COALESCE(booking_row.amount_charged, booking_row.total_price, 0) > 0;

  IF booking_row.status = 'completed' THEN
    IF booking_row.payment_status = 'captured' THEN
      NULL;
    ELSIF verified_offline_collection THEN
      -- Narrow owner-manual allowance. This is audited offline collection,
      -- never Stripe capture.
      NULL;
    ELSIF booking_row.payment_status IN ('partially_refunded', 'refunded')
       AND booking_row.payout_review_status = 'approved_full'
       AND booking_row.payout_reviewed_at IS NOT NULL
       AND COALESCE(BTRIM(booking_row.payout_reviewed_by), '') <> ''
       AND CHAR_LENGTH(BTRIM(COALESCE(booking_row.payout_review_notes, ''))) >= 10 THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Customer funds and payout review must be complete before payout. Payment: %, review: %',
        booking_row.payment_status, booking_row.payout_review_status USING ERRCODE = '22000';
    END IF;
    -- Job earnings, plus the owner-funded bonus (085), plus an owner-approved
    -- expense reimbursement (112). The API sends the same sum; until now this
    -- function compared it against assembler_due alone and refused any payout
    -- that carried a bonus.
    v_reimbursement_cents := COALESCE(booking_row.easer_reimbursement_cents, 0);
    canonical_due_cents := COALESCE(booking_row.assembler_due, 0)
      + COALESCE(booking_row.easer_bonus_cents, 0)
      + v_reimbursement_cents;
    IF booking_row.evidence_requested_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.booking_evidence evidence
       WHERE evidence.booking_id = booking_row.id
         AND evidence.evidence_type = 'completion_photo'
         AND evidence.uploaded_by = booking_row.assembler_id
         AND booking_row.job_started_at IS NOT NULL
         AND evidence.created_at >= GREATEST(booking_row.job_started_at, booking_row.evidence_requested_at)
    ) THEN
      RAISE EXCEPTION 'Valid current-Easer completion evidence is required before payout' USING ERRCODE = '22000';
    END IF;
  ELSIF booking_row.status = 'cancelled' THEN
    IF booking_row.payment_status <> 'cancellation_fee_captured' THEN
      RAISE EXCEPTION 'Cancellation fee must be captured before cancellation earnings can be paid' USING ERRCODE = '22000';
    END IF;
    canonical_due_cents := COALESCE(booking_row.cancellation_easer_due_cents, 0);
  ELSE
    RAISE EXCEPTION 'Only completed jobs or fee-bearing cancellations can be paid out. Current status: %', booking_row.status USING ERRCODE = '22000';
  END IF;

  IF booking_row.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No Easer assigned to this booking' USING ERRCODE = '22000';
  END IF;
  IF booking_row.payout_status IN ('paid', 'transferred') OR booking_row.stripe_transfer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Payout already recorded or transferred for this booking.' USING ERRCODE = '23505';
  END IF;
  IF canonical_due_cents <= 0 OR p_payout_amount_cents IS DISTINCT FROM canonical_due_cents THEN
    RAISE EXCEPTION 'Payout amount must exactly equal canonical Easer earnings of % cents', canonical_due_cents USING ERRCODE = '22000';
  END IF;
  IF COALESCE(BTRIM(p_notes), '') = '' THEN
    RAISE EXCEPTION 'A bank confirmation ID or payout reference is required' USING ERRCODE = '22000';
  END IF;

  amount_charged_cents := COALESCE(booking_row.amount_charged, booking_row.total_price, 0);
  net_captured_cents := GREATEST(0, amount_charged_cents - COALESCE(booking_row.refund_amount, 0));
  remaining_tax_cents := CASE
    WHEN booking_row.status = 'cancelled' OR amount_charged_cents <= 0 THEN 0
    ELSE ROUND(COALESCE(booking_row.tax_amount, 0)::NUMERIC * net_captured_cents / amount_charged_cents)::INTEGER
  END;
  stripe_fee_cents := COALESCE(
    booking_row.stripe_fee,
    CASE WHEN net_captured_cents > 0 THEN ROUND(net_captured_cents * 0.029)::INTEGER + 30 ELSE 0 END
  );
  platform_revenue_cents := net_captured_cents - remaining_tax_cents - stripe_fee_cents - canonical_due_cents;

  UPDATE public.bookings SET
    payout_amount = canonical_due_cents,
    paid_out_at = NOW(),
    payout_notes = BTRIM(p_notes),
    payout_status = 'paid',
    platform_revenue = platform_revenue_cents,
    cancellation_easer_payout_status = CASE WHEN booking_row.status = 'cancelled' THEN 'paid' ELSE booking_row.cancellation_easer_payout_status END,
    financial_operation_key = NULL,
    financial_operation_type = NULL,
    financial_operation_started_at = NULL
  WHERE id = booking_row.id;

  INSERT INTO public.payout_ledger (
    booking_id, booking_ref, assembler_id, assembler_name, assembler_tier,
    service, booking_date, amount_charged, assembler_due, payout_amount,
    platform_revenue, payout_notes, recorded_by, payout_method, reimbursement_cents
  ) VALUES (
    booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, booking_row.service,
    booking_row.date::TEXT, amount_charged_cents, canonical_due_cents,
    canonical_due_cents, platform_revenue_cents, BTRIM(p_notes),
    COALESCE(p_recorded_by, 'owner'), normalized_method, v_reimbursement_cents
  );

  RETURN QUERY SELECT booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, canonical_due_cents,
    platform_revenue_cents, amount_charged_cents, canonical_due_cents, NOW();
END;
$$;


REVOKE ALL ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_booking_payout(UUID, INTEGER, TEXT, TEXT, TEXT)
  TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (120, 'thumbtack_external_bookings')
ON CONFLICT (migration_number) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
