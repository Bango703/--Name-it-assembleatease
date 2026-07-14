-- ============================================================
-- Migration 037: Owner/Easer workflow completion and safety
-- Apply after migration 036 and before deploying matching APIs.
--
-- P0 controls:
-- 1. Account closure is a database-level dispatch/access hold.
-- 2. Booking assignment and closure requests serialize on the Easer row.
-- 3. Booking messages have an explicit recipient and read state.
-- 4. Historical manual payout liabilities cannot be rerouted by a flag change.
-- 5. Manual payout methods and refund holds are enforced in the database.
-- ============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS previous_tier TEXT,
  ADD COLUMN IF NOT EXISTS payout_method_preference TEXT,
  ADD COLUMN IF NOT EXISTS account_closure_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_closure_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_closure_completed_by TEXT;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_previous_tier_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_previous_tier_check
  CHECK (previous_tier IS NULL OR previous_tier IN ('starter', 'professional', 'elite', 'verified'));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_payout_method_preference_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_payout_method_preference_check
  CHECK (
    payout_method_preference IS NULL
    OR payout_method_preference IN ('ach', 'zelle', 'paypal', 'check')
  );

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_closure_availability_check;

-- Normalize the exact state this constraint protects before PostgreSQL scans
-- existing rows. A requested closure must take the Easer offline even when an
-- older API left is_available=true.
UPDATE public.profiles
   SET is_available = FALSE
 WHERE role = 'assembler'
   AND account_closure_status IN ('requested', 'reviewing', 'completed')
   AND is_available IS TRUE;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_closure_availability_check
  CHECK (
    COALESCE(account_closure_status, '') NOT IN ('requested', 'reviewing', 'completed')
    OR is_available IS NOT TRUE
  );

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payout_mode_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS payout_review_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS payout_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS payout_review_notes TEXT,
  ADD COLUMN IF NOT EXISTS damage_review_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS damage_claim_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS damage_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS damage_reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS damage_review_notes TEXT,
  ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_reconciliation_required_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reconciliation_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_recovery_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_recovery_claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS financial_reconciliation_required_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS financial_reconciliation_reason TEXT,
  ADD COLUMN IF NOT EXISTS stripe_dispute_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_dispute_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_dispute_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_dispute_amount_cents INTEGER,
  ADD COLUMN IF NOT EXISTS stripe_dispute_reason TEXT,
  ADD COLUMN IF NOT EXISTS stripe_dispute_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_dispute_updated_at TIMESTAMPTZ;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_stripe_dispute_truth_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_stripe_dispute_truth_check
  CHECK (
    (
      (
        stripe_dispute_id IS NULL
        AND stripe_dispute_status IS NULL
        AND stripe_dispute_amount_cents IS NULL
        AND stripe_dispute_reason IS NULL
        AND stripe_dispute_opened_at IS NULL
        AND stripe_dispute_updated_at IS NULL
      )
      OR (
        NULLIF(BTRIM(stripe_dispute_id), '') IS NOT NULL
        AND NULLIF(BTRIM(stripe_dispute_status), '') IS NOT NULL
        AND stripe_dispute_amount_cents > 0
        AND stripe_dispute_opened_at IS NOT NULL
        AND stripe_dispute_updated_at IS NOT NULL
      )
    )
    AND (stripe_dispute_hold IS NOT TRUE OR stripe_dispute_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_bookings_stripe_dispute_hold
  ON public.bookings(stripe_dispute_updated_at)
  WHERE stripe_dispute_hold IS TRUE;

CREATE TABLE IF NOT EXISTS public.booking_stripe_disputes (
  dispute_id TEXT PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  payment_intent_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  reason TEXT,
  livemode BOOLEAN NOT NULL,
  blocking BOOLEAN NOT NULL DEFAULT TRUE,
  opened_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  funds_withdrawn_at TIMESTAMPTZ,
  funds_reinstated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_stripe_disputes_booking_blocking
  ON public.booking_stripe_disputes(booking_id, blocking, updated_at DESC);

ALTER TABLE public.booking_stripe_disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_stripe_disputes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_stripe_disputes TO service_role;

-- Financial cancellation terms use the booking row as truth. Backfill the
-- counter from historical audit records once, then all new reschedules update
-- the counter atomically; activity logs remain an audit trail, not fee truth.
WITH historical_reschedules AS (
  SELECT booking_id, COUNT(*)::INTEGER AS reschedule_count, MAX(created_at) AS last_rescheduled_at
    FROM public.activity_logs
   WHERE event_type = 'rescheduled'
     AND booking_id IS NOT NULL
   GROUP BY booking_id
)
UPDATE public.bookings booking
   SET reschedule_count = GREATEST(booking.reschedule_count, history.reschedule_count),
       rescheduled_at = COALESCE(booking.rescheduled_at, history.last_rescheduled_at)
  FROM historical_reschedules history
 WHERE booking.id = history.booking_id;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_reschedule_count_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_reschedule_count_check
  CHECK (reschedule_count >= 0);

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_financial_operation_type_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_financial_operation_type_check
  CHECK (
    financial_operation_type IS NULL OR financial_operation_type IN (
      'completion_owner', 'completion_easer',
      'cancel_owner', 'cancel_customer', 'cancel_guest',
      'payout_manual', 'payout_connect', 'refund_owner',
      'reauth_payment', 'expire_payment'
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.bookings
     WHERE (financial_operation_key IS NULL)
             IS DISTINCT FROM (financial_operation_type IS NULL)
        OR (financial_operation_key IS NULL)
             IS DISTINCT FROM (financial_operation_started_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'Malformed booking financial lock tuples must be reconciled before migration 037';
  END IF;
END;
$$;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_financial_operation_tuple_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_financial_operation_tuple_check
  CHECK (
    (financial_operation_key IS NULL
      AND financial_operation_type IS NULL
      AND financial_operation_started_at IS NULL)
    OR
    (financial_operation_key IS NOT NULL
      AND financial_operation_type IS NOT NULL
      AND financial_operation_started_at IS NOT NULL)
  );

-- Migration 035 introduced the central row-locking reservation RPC before
-- owner refunds used it. Keep one reservation source of truth and extend its
-- operation whitelist here; the financial snapshot already includes every
-- linked PaymentIntent and payout field needed by a refund.
CREATE OR REPLACE FUNCTION public.reserve_booking_financial_operation(
  p_booking_id UUID,
  p_operation_key TEXT,
  p_operation_type TEXT,
  p_expected_statuses TEXT[],
  p_expected_assembler_id UUID DEFAULT NULL,
  p_check_assembler_id BOOLEAN DEFAULT TRUE,
  p_expected_date TEXT DEFAULT NULL,
  p_expected_time TEXT DEFAULT NULL,
  p_check_appointment BOOLEAN DEFAULT FALSE,
  p_expected_financial_snapshot JSONB DEFAULT NULL
)
RETURNS TABLE (
  booking_id UUID,
  booking_status TEXT,
  assembler_id UUID,
  operation_key TEXT,
  operation_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
BEGIN
  IF COALESCE(BTRIM(p_operation_key), '') = '' THEN
    RAISE EXCEPTION 'Financial operation key is required' USING ERRCODE = '22000';
  END IF;
  IF p_operation_type NOT IN (
    'completion_owner', 'completion_easer',
    'cancel_owner', 'cancel_customer', 'cancel_guest',
    'payout_manual', 'payout_connect', 'refund_owner',
    'reauth_payment', 'expire_payment'
  ) THEN
    RAISE EXCEPTION 'Unsupported financial operation type: %', p_operation_type USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_statuses IS NOT NULL
     AND array_length(p_expected_statuses, 1) IS NOT NULL
     AND NOT (v_booking.status = ANY(p_expected_statuses)) THEN
    RAISE EXCEPTION 'Booking state changed before financial operation. Current status: %', v_booking.status USING ERRCODE = '55P03';
  END IF;
  IF p_check_assembler_id
     AND v_booking.assembler_id IS DISTINCT FROM p_expected_assembler_id THEN
    RAISE EXCEPTION 'Booking assignee changed before financial operation' USING ERRCODE = '55P03';
  END IF;
  IF p_check_appointment
     AND (
       v_booking.date::TEXT IS DISTINCT FROM p_expected_date
       OR v_booking.time::TEXT IS DISTINCT FROM p_expected_time
     ) THEN
    RAISE EXCEPTION 'Booking appointment changed before financial operation' USING ERRCODE = '55P03';
  END IF;
  IF p_expected_financial_snapshot IS NOT NULL
     AND jsonb_build_object(
       'payment_status', v_booking.payment_status,
       'total_price', v_booking.total_price,
       'tax_amount', v_booking.tax_amount,
       'service_call_fee', v_booking.service_call_fee,
       'amount_charged', v_booking.amount_charged,
       'refund_amount', v_booking.refund_amount,
       'is_deposit', v_booking.is_deposit,
       'deposit_amount', v_booking.deposit_amount,
       'cancellation_fee', v_booking.cancellation_fee,
       'stripe_customer_id', v_booking.stripe_customer_id,
       'stripe_payment_intent_id', v_booking.stripe_payment_intent_id,
       'stripe_deposit_intent_id', v_booking.stripe_deposit_intent_id,
       'stripe_balance_payment_intent_id', v_booking.stripe_balance_payment_intent_id,
       'stripe_balance_amount_captured', v_booking.stripe_balance_amount_captured,
       'payout_status', v_booking.payout_status,
       'payout_amount', v_booking.payout_amount,
       'payout_mode_snapshot', v_booking.payout_mode_snapshot,
       'payout_review_status', v_booking.payout_review_status,
       'payout_reviewed_at', v_booking.payout_reviewed_at,
       'payout_reviewed_by', v_booking.payout_reviewed_by,
       'payout_review_notes', v_booking.payout_review_notes,
       'evidence_requested_at', v_booking.evidence_requested_at,
       'job_started_at', v_booking.job_started_at,
       'damage_review_status', v_booking.damage_review_status,
       'damage_claim_opened_at', v_booking.damage_claim_opened_at,
       'damage_reviewed_at', v_booking.damage_reviewed_at,
       'damage_reviewed_by', v_booking.damage_reviewed_by,
       'damage_review_notes', v_booking.damage_review_notes,
       'paid_out_at', v_booking.paid_out_at,
       'stripe_transfer_id', v_booking.stripe_transfer_id,
       'assembler_due', v_booking.assembler_due,
       'cancellation_easer_payout_status', v_booking.cancellation_easer_payout_status,
       'cancellation_easer_due_cents', v_booking.cancellation_easer_due_cents,
       'assemblecash_redeemed_cents', v_booking.assemblecash_redeemed_cents,
       'reschedule_count', v_booking.reschedule_count,
       'rescheduled_at', v_booking.rescheduled_at,
       'easer_fee_snapshot_easer_id', v_booking.easer_fee_snapshot_easer_id,
       'easer_fee_pct_snapshot', v_booking.easer_fee_pct_snapshot,
       'easer_estimated_due_snapshot', v_booking.easer_estimated_due_snapshot
     ) IS DISTINCT FROM p_expected_financial_snapshot THEN
    RAISE EXCEPTION 'Booking financial state changed before financial operation' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type IN ('payout_manual', 'payout_connect')
     AND (
       v_booking.payout_status IS DISTINCT FROM 'pending'
       OR v_booking.stripe_transfer_id IS NOT NULL
       OR v_booking.damage_review_status = 'review_required'
       OR v_booking.payout_review_status = 'review_required'
       OR (
         v_booking.damage_review_status = 'resolved'
         AND (
           v_booking.damage_claim_opened_at IS NULL
           OR v_booking.damage_reviewed_at IS NULL
           OR COALESCE(BTRIM(v_booking.damage_reviewed_by), '') = ''
           OR CHAR_LENGTH(BTRIM(COALESCE(v_booking.damage_review_notes, ''))) < 10
         )
       )
       OR (
         v_booking.payout_review_status = 'approved_full'
         AND (
           v_booking.payout_reviewed_at IS NULL
           OR COALESCE(BTRIM(v_booking.payout_reviewed_by), '') = ''
           OR CHAR_LENGTH(BTRIM(COALESCE(v_booking.payout_review_notes, ''))) < 10
         )
       )
       OR (
         v_booking.status = 'completed'
         AND v_booking.evidence_requested_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.booking_evidence evidence
            WHERE evidence.booking_id = v_booking.id
              AND evidence.evidence_type = 'completion_photo'
              AND evidence.uploaded_by = v_booking.assembler_id
              AND v_booking.job_started_at IS NOT NULL
              AND evidence.created_at >= GREATEST(v_booking.job_started_at, v_booking.evidence_requested_at)
         )
       )
       OR (p_operation_type = 'payout_manual' AND v_booking.payout_mode_snapshot IS DISTINCT FROM 'manual')
       OR (p_operation_type = 'payout_connect' AND v_booking.payout_mode_snapshot IS DISTINCT FROM 'stripe_connect')
     ) THEN
    RAISE EXCEPTION 'Booking payout state changed before payout reservation' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type IN ('cancel_owner', 'cancel_customer', 'cancel_guest')
     AND (
       v_booking.payout_status IN ('paid', 'transferred')
       OR v_booking.cancellation_easer_payout_status IN ('paid', 'transferred')
       OR v_booking.stripe_transfer_id IS NOT NULL
       OR COALESCE(v_booking.payout_amount, 0) > 0
       OR v_booking.paid_out_at IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = v_booking.id)
     ) THEN
    RAISE EXCEPTION 'Booking payout must be reconciled before cancellation' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type = 'reauth_payment'
     AND (
       v_booking.status IS DISTINCT FROM 'confirmed'
       OR v_booking.payment_status IS DISTINCT FROM 'authorized'
       OR v_booking.stripe_payment_intent_id IS NULL
       OR BTRIM(p_operation_key) IS DISTINCT FROM ('reauth:' || v_booking.id::TEXT)
     ) THEN
    RAISE EXCEPTION 'Booking is not eligible for payment reauthorization' USING ERRCODE = '55P03';
  END IF;
  IF p_operation_type = 'expire_payment'
     AND (
       v_booking.status IS DISTINCT FROM 'pending'
       OR BTRIM(p_operation_key) IS DISTINCT FROM ('expire:pending:' || v_booking.id::TEXT)
     ) THEN
    RAISE EXCEPTION 'Booking is not eligible for pending-payment expiration' USING ERRCODE = '55P03';
  END IF;

  IF v_booking.financial_reconciliation_required_at IS NOT NULL
     AND v_booking.financial_operation_key IS NULL THEN
    RAISE EXCEPTION 'A malformed financial reconciliation hold blocks new financial operations'
      USING ERRCODE = '55P03';
  END IF;

  IF (v_booking.financial_operation_key IS NULL)
       IS DISTINCT FROM (v_booking.financial_operation_type IS NULL)
     OR (v_booking.financial_operation_key IS NULL)
       IS DISTINCT FROM (v_booking.financial_operation_started_at IS NULL) THEN
    RAISE EXCEPTION 'Booking has a malformed financial operation lock' USING ERRCODE = '55P03';
  ELSIF v_booking.financial_operation_key IS NULL THEN
    UPDATE public.bookings
       SET financial_operation_key = BTRIM(p_operation_key),
           financial_operation_type = p_operation_type,
           financial_operation_started_at = NOW()
     WHERE id = v_booking.id;
  ELSIF v_booking.financial_operation_key IS DISTINCT FROM BTRIM(p_operation_key) THEN
    RAISE EXCEPTION 'Another financial operation is already in progress: %', v_booking.financial_operation_type USING ERRCODE = '55P03';
  ELSIF v_booking.financial_operation_type IS DISTINCT FROM p_operation_type
     AND NOT COALESCE(
       v_booking.financial_operation_type IN ('completion_owner', 'completion_easer')
       AND p_operation_type IN ('completion_owner', 'completion_easer'),
       FALSE
     ) THEN
    RAISE EXCEPTION 'Another financial operation is already in progress: %', v_booking.financial_operation_type USING ERRCODE = '55P03';
  END IF;

  RETURN QUERY SELECT v_booking.id, v_booking.status, v_booking.assembler_id,
    BTRIM(p_operation_key), p_operation_type;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_booking_financial_operation(
  UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN, TEXT, TEXT, BOOLEAN, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_booking_financial_operation(
  UUID, TEXT, TEXT, TEXT[], UUID, BOOLEAN, TEXT, TEXT, BOOLEAN, JSONB
) TO service_role;

-- A customer/guest cancellation can safely hand control to the owner only after
-- its reconciliation hold has been durable for five minutes. Rotating the key
-- atomically prevents the original caller from resuming alongside the owner.
CREATE OR REPLACE FUNCTION public.claim_booking_cancellation_recovery(
  p_booking_id UUID,
  p_expected_operation_key TEXT,
  p_owner_operation_key TEXT,
  p_expected_status TEXT,
  p_expected_assembler_id UUID,
  p_expected_date TEXT,
  p_expected_time TEXT,
  p_expected_financial_snapshot JSONB
)
RETURNS TABLE (
  booking_id UUID,
  operation_key TEXT,
  operation_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_customer_key TEXT;
  v_guest_key TEXT;
  v_owner_key TEXT;
  v_updated_rows INTEGER;
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  v_customer_key := 'cancel:customer:' || v_booking.id::TEXT;
  v_guest_key := 'cancel:guest:' || v_booking.id::TEXT;
  v_owner_key := 'cancel:owner:' || v_booking.id::TEXT;
  IF p_owner_operation_key IS DISTINCT FROM v_owner_key
     OR p_expected_operation_key IS DISTINCT FROM v_booking.financial_operation_key THEN
    RAISE EXCEPTION 'Cancellation recovery ownership changed' USING ERRCODE = '55P03';
  END IF;
  IF NOT (
    (v_booking.financial_operation_type IS NOT DISTINCT FROM 'cancel_customer'
      AND v_booking.financial_operation_key IS NOT DISTINCT FROM v_customer_key)
    OR
    (v_booking.financial_operation_type IS NOT DISTINCT FROM 'cancel_guest'
      AND v_booking.financial_operation_key IS NOT DISTINCT FROM v_guest_key)
  ) THEN
    RAISE EXCEPTION 'Cancellation recovery ownership changed' USING ERRCODE = '55P03';
  END IF;
  IF v_booking.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'Booking state changed before cancellation recovery' USING ERRCODE = '55P03';
  END IF;
  IF v_booking.assembler_id IS DISTINCT FROM p_expected_assembler_id THEN
    RAISE EXCEPTION 'Booking assignee changed before cancellation recovery' USING ERRCODE = '55P03';
  END IF;
  IF v_booking.date::TEXT IS DISTINCT FROM p_expected_date
     OR v_booking.time::TEXT IS DISTINCT FROM p_expected_time THEN
    RAISE EXCEPTION 'Booking appointment changed before cancellation recovery' USING ERRCODE = '55P03';
  END IF;
  IF jsonb_build_object(
       'payment_status', v_booking.payment_status,
       'total_price', v_booking.total_price,
       'tax_amount', v_booking.tax_amount,
       'service_call_fee', v_booking.service_call_fee,
       'amount_charged', v_booking.amount_charged,
       'refund_amount', v_booking.refund_amount,
       'is_deposit', v_booking.is_deposit,
       'deposit_amount', v_booking.deposit_amount,
       'cancellation_fee', v_booking.cancellation_fee,
       'stripe_customer_id', v_booking.stripe_customer_id,
       'stripe_payment_intent_id', v_booking.stripe_payment_intent_id,
       'stripe_deposit_intent_id', v_booking.stripe_deposit_intent_id,
       'stripe_balance_payment_intent_id', v_booking.stripe_balance_payment_intent_id,
       'stripe_balance_amount_captured', v_booking.stripe_balance_amount_captured,
       'payout_status', v_booking.payout_status,
       'payout_amount', v_booking.payout_amount,
       'payout_mode_snapshot', v_booking.payout_mode_snapshot,
       'payout_review_status', v_booking.payout_review_status,
       'payout_reviewed_at', v_booking.payout_reviewed_at,
       'payout_reviewed_by', v_booking.payout_reviewed_by,
       'payout_review_notes', v_booking.payout_review_notes,
       'evidence_requested_at', v_booking.evidence_requested_at,
       'job_started_at', v_booking.job_started_at,
       'damage_review_status', v_booking.damage_review_status,
       'damage_claim_opened_at', v_booking.damage_claim_opened_at,
       'damage_reviewed_at', v_booking.damage_reviewed_at,
       'damage_reviewed_by', v_booking.damage_reviewed_by,
       'damage_review_notes', v_booking.damage_review_notes,
       'paid_out_at', v_booking.paid_out_at,
       'stripe_transfer_id', v_booking.stripe_transfer_id,
       'assembler_due', v_booking.assembler_due,
       'cancellation_easer_payout_status', v_booking.cancellation_easer_payout_status,
       'cancellation_easer_due_cents', v_booking.cancellation_easer_due_cents,
       'assemblecash_redeemed_cents', v_booking.assemblecash_redeemed_cents,
       'reschedule_count', v_booking.reschedule_count,
       'rescheduled_at', v_booking.rescheduled_at,
       'easer_fee_snapshot_easer_id', v_booking.easer_fee_snapshot_easer_id,
       'easer_fee_pct_snapshot', v_booking.easer_fee_pct_snapshot,
       'easer_estimated_due_snapshot', v_booking.easer_estimated_due_snapshot
     ) IS DISTINCT FROM p_expected_financial_snapshot THEN
    RAISE EXCEPTION 'Booking financial state changed before cancellation recovery' USING ERRCODE = '55P03';
  END IF;
  IF v_booking.dispatch_paused IS DISTINCT FROM TRUE
     OR v_booking.dispatch_status IS DISTINCT FROM 'payment_hold'
     OR v_booking.cancellation_reconciliation_required_at IS NULL
     OR v_booking.cancellation_reconciliation_required_at > NOW() - INTERVAL '5 minutes'
     OR v_booking.financial_operation_started_at IS NULL
     OR v_booking.financial_operation_started_at > NOW() - INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Cancellation recovery hold is not yet eligible for owner takeover' USING ERRCODE = '55P03';
  END IF;
  IF v_booking.payout_status IN ('paid', 'transferred')
     OR v_booking.cancellation_easer_payout_status IN ('paid', 'transferred')
     OR v_booking.stripe_transfer_id IS NOT NULL
     OR COALESCE(v_booking.payout_amount, 0) > 0
     OR v_booking.paid_out_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = v_booking.id) THEN
    RAISE EXCEPTION 'Booking payout must be reconciled before cancellation recovery' USING ERRCODE = '55P03';
  END IF;

  UPDATE public.bookings
     SET financial_operation_key = v_owner_key,
         financial_operation_type = 'cancel_owner',
         cancellation_recovery_claimed_at = NOW(),
         cancellation_recovery_claimed_by = 'owner'
   WHERE id = v_booking.id
     AND financial_operation_key = p_expected_operation_key;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Cancellation recovery key rotation failed' USING ERRCODE = '55P03';
  END IF;

  RETURN QUERY SELECT v_booking.id, v_owner_key, 'cancel_owner'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_booking_cancellation_recovery(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_booking_cancellation_recovery(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) TO service_role;

-- A refund after an Easer payout opens one cumulative clawback action. The API
-- and Stripe webhook can race, so application read-before-write checks are not
-- enough by themselves. Fail the migration visibly if historical duplicates
-- need owner reconciliation; never silently delete financial audit records.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.financial_event_audit
     WHERE event_type = 'clawback_required'
       AND idempotency_key IS NOT NULL
     GROUP BY idempotency_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate clawback audit keys must be reconciled before migration 037';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_event_clawback_idempotency
  ON public.financial_event_audit (idempotency_key)
  WHERE event_type = 'clawback_required' AND idempotency_key IS NOT NULL;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payout_mode_snapshot_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payout_mode_snapshot_check
  CHECK (payout_mode_snapshot IS NULL OR payout_mode_snapshot IN ('manual', 'stripe_connect'));

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payout_review_status_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payout_review_status_check
  CHECK (payout_review_status IN ('not_required', 'review_required', 'approved_full'));

-- A damage report is operational evidence and a payout hold, not an email-only
-- alert. Historical damage evidence is conservatively opened for owner review.
WITH existing_damage AS (
  SELECT booking_id, MAX(created_at) AS opened_at
    FROM public.booking_evidence
   WHERE evidence_type = 'damage_claim'
   GROUP BY booking_id
)
UPDATE public.bookings booking
   SET damage_review_status = 'review_required',
       damage_claim_opened_at = damage.opened_at,
       damage_reviewed_at = NULL,
       damage_reviewed_by = NULL,
       damage_review_notes = NULL
  FROM existing_damage damage
 WHERE booking.id = damage.booking_id
   AND booking.damage_review_status = 'not_required';

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_damage_review_status_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_damage_review_status_check
  CHECK (damage_review_status IN ('not_required', 'review_required', 'resolved'));

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_damage_review_truth_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_damage_review_truth_check
  CHECK (
    (damage_review_status = 'not_required'
      AND damage_claim_opened_at IS NULL
      AND damage_reviewed_at IS NULL
      AND damage_reviewed_by IS NULL
      AND damage_review_notes IS NULL)
    OR
    (damage_review_status = 'review_required'
      AND damage_claim_opened_at IS NOT NULL
      AND damage_reviewed_at IS NULL
      AND damage_reviewed_by IS NULL
      AND damage_review_notes IS NULL)
    OR
    (damage_review_status = 'resolved'
      AND damage_claim_opened_at IS NOT NULL
      AND damage_reviewed_at IS NOT NULL
      AND COALESCE(BTRIM(damage_reviewed_by), '') <> ''
      AND CHAR_LENGTH(BTRIM(COALESCE(damage_review_notes, ''))) BETWEEN 10 AND 1000)
  );

CREATE INDEX IF NOT EXISTS idx_bookings_damage_review_hold
  ON public.bookings (damage_claim_opened_at, id)
  WHERE damage_review_status = 'review_required';

-- Evidence writes must pass through the row-locking service RPC below. The old
-- direct authenticated INSERT policy could bypass the transactional file cap
-- and could create a damage row without opening the payout hold.
DROP POLICY IF EXISTS "easer_insert_own_booking_evidence" ON public.booking_evidence;

CREATE OR REPLACE FUNCTION public.request_booking_evidence_hold(
  p_booking_id UUID
)
RETURNS TABLE (
  booking_id UUID,
  booking_ref TEXT,
  booking_status TEXT,
  assembler_id UUID,
  assembler_name TEXT,
  service TEXT,
  booking_date TEXT,
  evidence_requested_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_requested_at TIMESTAMPTZ;
  v_evidence_count INTEGER;
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_booking.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'Evidence can only be requested for completed jobs' USING ERRCODE = '23514';
  END IF;
  IF v_booking.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No Easer is assigned to this booking' USING ERRCODE = '23514';
  END IF;
  IF v_booking.evidence_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Evidence has already been requested for this booking' USING ERRCODE = '23505';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'A financial operation is active; evidence cannot be requested now' USING ERRCODE = '55P03';
  END IF;
  IF v_booking.payout_status IN ('paid', 'transferred')
     OR v_booking.cancellation_easer_payout_status IN ('paid', 'transferred')
     OR v_booking.stripe_transfer_id IS NOT NULL
     OR COALESCE(v_booking.payout_amount, 0) > 0
     OR v_booking.paid_out_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = v_booking.id) THEN
    RAISE EXCEPTION 'Evidence cannot be requested after Easer payment or transfer' USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_evidence_count
    FROM public.booking_evidence evidence
   WHERE evidence.booking_id = v_booking.id;
  IF v_evidence_count >= 5 THEN
    RAISE EXCEPTION 'Evidence cannot be requested because this booking already has five evidence files' USING ERRCODE = '23514';
  END IF;

  v_requested_at := NOW();
  UPDATE public.bookings
     SET evidence_requested_at = v_requested_at
   WHERE id = v_booking.id;

  RETURN QUERY SELECT v_booking.id, v_booking.ref, v_booking.status,
    v_booking.assembler_id, v_booking.assembler_name, v_booking.service,
    v_booking.date::TEXT, v_requested_at;
END;
$$;

REVOKE ALL ON FUNCTION public.request_booking_evidence_hold(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_booking_evidence_hold(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_booking_evidence(
  p_booking_id UUID,
  p_uploaded_by UUID,
  p_storage_path TEXT,
  p_evidence_type TEXT,
  p_mime_type TEXT,
  p_file_size_bytes INTEGER,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  evidence_id UUID,
  evidence_type TEXT,
  mime_type TEXT,
  file_size_bytes INTEGER,
  created_at TIMESTAMPTZ,
  damage_review_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.booking_evidence%ROWTYPE;
  v_evidence public.booking_evidence%ROWTYPE;
  v_evidence_count INTEGER;
  v_clean_notes TEXT := NULLIF(BTRIM(COALESCE(p_notes, '')), '');
BEGIN
  IF p_evidence_type NOT IN ('completion_photo', 'before_photo', 'damage_claim') THEN
    RAISE EXCEPTION 'Unsupported Easer evidence type: %', p_evidence_type USING ERRCODE = '22000';
  END IF;
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif') THEN
    RAISE EXCEPTION 'Unsupported evidence MIME type: %', p_mime_type USING ERRCODE = '22000';
  END IF;
  IF p_file_size_bytes IS NULL OR p_file_size_bytes <= 0 OR p_file_size_bytes > 5242880 THEN
    RAISE EXCEPTION 'Evidence file size must be between 1 byte and 5 MB' USING ERRCODE = '22000';
  END IF;
  IF CHAR_LENGTH(COALESCE(v_clean_notes, '')) > 2000
     OR (p_evidence_type = 'damage_claim' AND CHAR_LENGTH(COALESCE(v_clean_notes, '')) < 10) THEN
    RAISE EXCEPTION 'Evidence notes do not meet the required length' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(BTRIM(p_storage_path), '') = ''
     OR p_storage_path NOT LIKE ('evidence/' || v_booking.id::TEXT || '/%') THEN
    RAISE EXCEPTION 'Evidence storage path does not match the booking' USING ERRCODE = '22000';
  END IF;

  -- A retry after an ambiguous RPC response returns the already-committed row
  -- instead of deleting its storage object or opening a duplicate review.
  SELECT * INTO v_existing
    FROM public.booking_evidence evidence
   WHERE evidence.storage_path = p_storage_path;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM v_booking.id
       OR v_existing.uploaded_by IS DISTINCT FROM p_uploaded_by
       OR v_existing.evidence_type IS DISTINCT FROM p_evidence_type
       OR v_existing.mime_type IS DISTINCT FROM p_mime_type
       OR v_existing.file_size_bytes IS DISTINCT FROM p_file_size_bytes THEN
      RAISE EXCEPTION 'Evidence storage path is already linked to different evidence' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.evidence_type,
      v_existing.mime_type, v_existing.file_size_bytes, v_existing.created_at,
      v_booking.damage_review_status;
    RETURN;
  END IF;

  IF v_booking.assembler_id IS DISTINCT FROM p_uploaded_by THEN
    RAISE EXCEPTION 'Booking is not assigned to this Easer' USING ERRCODE = '42501';
  END IF;
  IF v_booking.assembler_accepted_at IS NULL THEN
    RAISE EXCEPTION 'The Easer must accept the assignment before uploading evidence' USING ERRCODE = '23514';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'A financial operation is active; evidence cannot be uploaded now' USING ERRCODE = '55P03';
  END IF;
  IF p_evidence_type = 'before_photo'
     AND v_booking.status NOT IN ('arrived', 'in_progress') THEN
    RAISE EXCEPTION 'Before photos require an arrived or in-progress job' USING ERRCODE = '23514';
  ELSIF p_evidence_type = 'completion_photo'
     AND (v_booking.status NOT IN ('in_progress', 'completed') OR v_booking.job_started_at IS NULL) THEN
    RAISE EXCEPTION 'Completion photos require work to have started' USING ERRCODE = '23514';
  ELSIF p_evidence_type = 'damage_claim'
     AND v_booking.status NOT IN ('arrived', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Damage evidence requires an arrived, in-progress, or completed job' USING ERRCODE = '23514';
  END IF;

  -- The booking row lock serializes every evidence insert for this booking, so
  -- concurrent fifth/sixth uploads cannot both pass this count.
  SELECT COUNT(*)::INTEGER INTO v_evidence_count
    FROM public.booking_evidence evidence
   WHERE evidence.booking_id = v_booking.id;
  IF v_evidence_count >= 5 THEN
    RAISE EXCEPTION 'Maximum 5 evidence files per booking' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.booking_evidence (
    booking_id, uploaded_by, storage_path, evidence_type, mime_type,
    file_size_bytes, visibility, notes
  ) VALUES (
    v_booking.id, p_uploaded_by, BTRIM(p_storage_path), p_evidence_type,
    p_mime_type, p_file_size_bytes, 'owner', v_clean_notes
  ) RETURNING * INTO v_evidence;

  IF p_evidence_type = 'damage_claim' THEN
    UPDATE public.bookings
       SET damage_review_status = 'review_required',
           damage_claim_opened_at = v_evidence.created_at,
           damage_reviewed_at = NULL,
           damage_reviewed_by = NULL,
           damage_review_notes = NULL
     WHERE id = v_booking.id;
    v_booking.damage_review_status := 'review_required';
  END IF;

  RETURN QUERY SELECT v_evidence.id, v_evidence.evidence_type,
    v_evidence.mime_type, v_evidence.file_size_bytes, v_evidence.created_at,
    v_booking.damage_review_status;
END;
$$;

REVOKE ALL ON FUNCTION public.record_booking_evidence(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_booking_evidence(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_booking_damage_review(
  p_booking_id UUID,
  p_notes TEXT,
  p_reviewed_by TEXT DEFAULT 'owner'
)
RETURNS TABLE (
  booking_id UUID,
  booking_ref TEXT,
  assembler_id UUID,
  assembler_name TEXT,
  assembler_due INTEGER,
  payout_status TEXT,
  payout_mode_snapshot TEXT,
  damage_review_status TEXT,
  already_resolved BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_notes TEXT := BTRIM(COALESCE(p_notes, ''));
  v_reviewer TEXT := BTRIM(COALESCE(p_reviewed_by, ''));
BEGIN
  IF CHAR_LENGTH(v_notes) < 10 OR CHAR_LENGTH(v_notes) > 1000 THEN
    RAISE EXCEPTION 'Damage review note must be between 10 and 1000 characters' USING ERRCODE = '22000';
  END IF;
  IF v_reviewer = '' THEN
    RAISE EXCEPTION 'Damage reviewer is required' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_booking.damage_review_status = 'resolved' THEN
    RETURN QUERY SELECT v_booking.id, v_booking.ref, v_booking.assembler_id,
      v_booking.assembler_name, v_booking.assembler_due, v_booking.payout_status,
      v_booking.payout_mode_snapshot, v_booking.damage_review_status, TRUE;
    RETURN;
  END IF;
  IF v_booking.damage_review_status IS DISTINCT FROM 'review_required' THEN
    RAISE EXCEPTION 'This booking has no open damage review' USING ERRCODE = '23514';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'A financial operation is active; damage review cannot be resolved now' USING ERRCODE = '55P03';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_evidence evidence
     WHERE evidence.booking_id = v_booking.id
       AND evidence.evidence_type = 'damage_claim'
  ) THEN
    RAISE EXCEPTION 'Damage review has no durable damage evidence' USING ERRCODE = '23514';
  END IF;

  UPDATE public.bookings
     SET damage_review_status = 'resolved',
         damage_reviewed_at = NOW(),
         damage_reviewed_by = v_reviewer,
         damage_review_notes = v_notes
   WHERE id = v_booking.id;

  RETURN QUERY SELECT v_booking.id, v_booking.ref, v_booking.assembler_id,
    v_booking.assembler_name, v_booking.assembler_due, v_booking.payout_status,
    v_booking.payout_mode_snapshot, 'resolved'::TEXT, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_booking_damage_review(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_booking_damage_review(UUID, TEXT, TEXT)
  TO service_role;

-- Fail safe for historical liabilities: an existing transfer is Connect truth;
-- every other already-created earning remains manual until explicitly reconciled.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.bookings b
     WHERE b.assembler_id IS NOT NULL
       AND (
         (b.status = 'completed' AND COALESCE(b.assembler_due, 0) > 0)
         OR (b.status = 'cancelled' AND COALESCE(b.cancellation_easer_due_cents, 0) > 0)
       )
       AND (
         b.payout_status IN ('paid', 'transferred')
         OR b.cancellation_easer_payout_status IN ('paid', 'transferred')
         OR b.stripe_transfer_id IS NOT NULL
         OR COALESCE(b.payout_amount, 0) > 0
         OR b.paid_out_at IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.payout_ledger evidence WHERE evidence.booking_id = b.id)
       )
       AND NOT (
         (
           b.stripe_transfer_id IS NULL
           AND b.payout_status IS NOT DISTINCT FROM 'paid'
           AND b.payout_amount IS NOT DISTINCT FROM CASE
             WHEN b.status = 'cancelled' THEN b.cancellation_easer_due_cents
             ELSE b.assembler_due
           END
           AND (b.status IS DISTINCT FROM 'cancelled'
             OR b.cancellation_easer_payout_status IS NOT DISTINCT FROM 'paid')
           AND EXISTS (
             SELECT 1
               FROM public.payout_ledger ledger
              WHERE ledger.booking_id = b.id
                AND ledger.assembler_id = b.assembler_id
                AND ledger.payout_amount IS NOT DISTINCT FROM CASE
                  WHEN b.status = 'cancelled' THEN b.cancellation_easer_due_cents
                  ELSE b.assembler_due
                END
           )
         )
         OR
         (
           b.stripe_transfer_id IS NOT NULL
           AND b.payout_status IS NOT DISTINCT FROM 'transferred'
           AND b.payout_amount IS NOT DISTINCT FROM CASE
             WHEN b.status = 'cancelled' THEN b.cancellation_easer_due_cents
             ELSE b.assembler_due
           END
           AND (b.status IS DISTINCT FROM 'cancelled'
             OR b.cancellation_easer_payout_status IS NOT DISTINCT FROM 'transferred')
           AND NOT EXISTS (
             SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = b.id
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'Contradictory or underpaid historical payout evidence must be reconciled before migration 037';
  END IF;
END;
$$;

UPDATE public.bookings b
   SET payout_status = 'pending',
       cancellation_easer_payout_status = CASE
         WHEN b.status = 'cancelled'
           AND COALESCE(b.cancellation_easer_due_cents, 0) > 0
           THEN COALESCE(b.cancellation_easer_payout_status, 'pending')
         ELSE b.cancellation_easer_payout_status
       END
 WHERE b.assembler_id IS NOT NULL
   AND b.payout_status IS NULL
   AND (
     (b.status = 'completed' AND COALESCE(b.assembler_due, 0) > 0)
     OR (b.status = 'cancelled' AND COALESCE(b.cancellation_easer_due_cents, 0) > 0)
   )
   AND b.stripe_transfer_id IS NULL
   AND COALESCE(b.payout_amount, 0) = 0
   AND b.paid_out_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = b.id);

UPDATE public.bookings
   SET payout_mode_snapshot = CASE
     WHEN stripe_transfer_id IS NOT NULL THEN 'stripe_connect'
     ELSE 'manual'
   END
 WHERE payout_mode_snapshot IS NULL
   AND assembler_id IS NOT NULL
   AND (
     COALESCE(assembler_due, 0) > 0
     OR COALESCE(cancellation_easer_due_cents, 0) > 0
     OR payout_status IN ('pending', 'paid', 'transferred')
   );

UPDATE public.bookings
   SET payout_review_status = 'review_required'
 WHERE status = 'completed'
   AND COALESCE(payout_status, 'pending') NOT IN ('paid', 'transferred')
   AND COALESCE(assembler_due, 0) > 0
   AND (COALESCE(refund_amount, 0) > 0 OR payment_status IN ('partially_refunded', 'refunded'))
   AND payout_review_status = 'not_required';

CREATE INDEX IF NOT EXISTS idx_bookings_manual_payout_queue
  ON public.bookings (completed_at, id)
  WHERE payout_mode_snapshot = 'manual' AND payout_status = 'pending';

-- --------------------------------------------------------------------------
-- Recipient-isolated booking messages
-- --------------------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS recipient_type TEXT,
  ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_recipient_type_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_recipient_type_check
  CHECK (recipient_type IS NULL OR recipient_type IN ('owner', 'customer', 'assembler'));

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_easer_recipient_identity_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_easer_recipient_identity_check
  CHECK (recipient_type IS DISTINCT FROM 'assembler' OR recipient_user_id IS NOT NULL);

-- Sender truth safely identifies messages addressed to the owner. Historical
-- owner messages cannot be assigned to customer vs Easer without evidence, so
-- they intentionally remain NULL and are visible only to the owner.
UPDATE public.messages
   SET recipient_type = 'owner'
 WHERE recipient_type IS NULL
   AND sender IN ('customer', 'assembler');

CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread
  ON public.messages (recipient_type, booking_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sender_user_thread
  ON public.messages (booking_id, sender_user_id, created_at)
  WHERE sender_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_recipient_user_thread
  ON public.messages (booking_id, recipient_user_id, created_at)
  WHERE recipient_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.can_read_easer_booking_messages(p_booking_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.bookings b
      JOIN public.profiles p ON p.id = auth.uid()
     WHERE b.id = p_booking_id
       AND b.assembler_id = auth.uid()
       AND p.role = 'assembler'
       AND p.status = 'active'
       AND p.application_status = 'approved'
       AND p.tier IN ('starter', 'professional', 'elite', 'verified')
       AND p.identity_verified IS TRUE
       AND p.contractor_agreement_signed_at IS NOT NULL
       AND p.code_of_conduct_agreed_at IS NOT NULL
       AND COALESCE(p.account_closure_status, '') NOT IN ('requested', 'reviewing', 'completed')
       AND p.application_fee_refunded IS NOT TRUE
       AND (
         (
           p.application_fee_refunded IS NOT TRUE
           AND COALESCE(p.application_fee_refunded_cents, 0) = 0
           AND COALESCE(p.application_fee_refund_pending_cents, 0) = 0
           AND p.application_fee_refund_review_required_at IS NULL
           AND (
             p.application_fee_paid IS TRUE
             OR p.application_fee_waived IS TRUE
             OR p.fee_waived_by_owner IS TRUE
           )
         )
         OR (
           p.application_fee_paid IS TRUE
           AND p.payment_confirmed IS TRUE
           AND (
             p.application_fee_refunded IS TRUE
             OR COALESCE(p.application_fee_refunded_cents, 0) > 0
             OR COALESCE(p.application_fee_refund_pending_cents, 0) > 0
             OR p.application_fee_refund_review_required_at IS NOT NULL
           )
         )
       )
  );
$$;

REVOKE ALL ON FUNCTION public.can_read_easer_booking_messages(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_easer_booking_messages(UUID)
  TO authenticated;

DROP POLICY IF EXISTS messages_assigned_active_easer_select ON public.messages;
CREATE POLICY messages_assigned_active_easer_select
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (
    public.can_read_easer_booking_messages(messages.booking_id)
    AND auth.uid() IS NOT NULL
    AND (
      messages.sender_user_id = auth.uid()
      OR messages.recipient_user_id = auth.uid()
    )
  );

-- --------------------------------------------------------------------------
-- Closure/assignment mutual exclusion
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.bookings b
      JOIN public.profiles p ON p.id = b.assembler_id
     WHERE b.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')
       AND p.account_closure_status IN ('requested', 'reviewing', 'completed')
  ) THEN
    RAISE EXCEPTION 'A closure-held Easer still has an active booking; reassign or cancel it before migration 037';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_easer_closure_profile_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM 'assembler' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.account_closure_status, '') IN ('requested', 'reviewing', 'completed')
     AND NEW.is_available IS TRUE THEN
    RAISE EXCEPTION 'A closure-held Easer cannot be online'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(NEW.account_closure_status, '') IN ('requested', 'reviewing', 'completed')
     AND COALESCE(OLD.account_closure_status, '') NOT IN ('requested', 'reviewing', 'completed')
     AND EXISTS (
       SELECT 1
         FROM public.bookings b
        WHERE b.assembler_id = NEW.id
          AND b.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')
     ) THEN
    RAISE EXCEPTION 'Account closure cannot start while active assignments exist'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.account_closure_status = 'completed'
     AND NEW.account_closure_status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'A completed account closure is terminal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.account_closure_status = 'completed'
     AND OLD.account_closure_status IS DISTINCT FROM 'completed'
     AND EXISTS (
       SELECT 1
         FROM public.bookings b
        WHERE b.assembler_id = NEW.id
          AND (
            (b.status = 'completed' AND COALESCE(b.assembler_due, 0) > 0)
            OR (
              b.status = 'cancelled'
              AND COALESCE(b.cancellation_easer_due_cents, 0) > 0
            )
           )
          AND NOT (
            (
              b.payout_mode_snapshot IS NOT DISTINCT FROM 'manual'
              AND b.payout_status IS NOT DISTINCT FROM 'paid'
              AND b.payout_amount IS NOT DISTINCT FROM CASE
                WHEN b.status = 'cancelled' THEN b.cancellation_easer_due_cents
                ELSE b.assembler_due
              END
              AND (b.status IS DISTINCT FROM 'cancelled'
                OR b.cancellation_easer_payout_status IS NOT DISTINCT FROM 'paid')
              AND b.stripe_transfer_id IS NULL
              AND EXISTS (
                SELECT 1
                  FROM public.payout_ledger ledger
                 WHERE ledger.booking_id = b.id
                   AND ledger.assembler_id = b.assembler_id
                   AND ledger.payout_amount IS NOT DISTINCT FROM CASE
                     WHEN b.status = 'cancelled' THEN b.cancellation_easer_due_cents
                     ELSE b.assembler_due
                   END
              )
            )
            OR
            (
              b.payout_mode_snapshot IS NOT DISTINCT FROM 'stripe_connect'
              AND b.payout_status IS NOT DISTINCT FROM 'transferred'
              AND b.payout_amount IS NOT DISTINCT FROM CASE
                WHEN b.status = 'cancelled' THEN b.cancellation_easer_due_cents
                ELSE b.assembler_due
              END
              AND (b.status IS DISTINCT FROM 'cancelled'
                OR b.cancellation_easer_payout_status IS NOT DISTINCT FROM 'transferred')
              AND b.stripe_transfer_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = b.id
              )
            )
          )
     ) THEN
    RAISE EXCEPTION 'Account closure cannot complete while Easer earnings remain unpaid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_easer_closure_state ON public.profiles;
CREATE TRIGGER profiles_guard_easer_closure_state
  BEFORE UPDATE OF account_closure_status, is_available ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_easer_closure_profile_state();

REVOKE ALL ON FUNCTION public.guard_easer_closure_profile_state()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_booking_easer_closure_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_closure_status TEXT;
  v_assignment_started BOOLEAN;
  v_payment_guard_required BOOLEAN;
BEGIN
  IF NEW.assembler_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_assignment_started := TRUE;
  ELSE
    v_assignment_started := NEW.assembler_id IS DISTINCT FROM OLD.assembler_id
      OR (NEW.assembler_accepted_at IS NOT NULL AND OLD.assembler_accepted_at IS NULL);
  END IF;

  v_payment_guard_required := v_assignment_started
    OR (
      TG_OP = 'UPDATE'
      AND NEW.status IS DISTINCT FROM OLD.status
      AND NEW.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')
    );

  IF v_payment_guard_required THEN
    IF NEW.stripe_dispute_hold IS TRUE THEN
      RAISE EXCEPTION 'A Stripe-disputed booking cannot be assigned, accepted, or started'
        USING ERRCODE = '23514';
    END IF;
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

  -- This lock is shared with request_easer_account_closure(). It makes profile
  -- closure and a new live assignment mutually exclusive.
  SELECT account_closure_status
    INTO v_closure_status
    FROM public.profiles
   WHERE id = NEW.assembler_id
     AND role = 'assembler'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned Easer profile not found' USING ERRCODE = '23503';
  END IF;
  IF COALESCE(v_closure_status, '') IN ('requested', 'reviewing', 'completed')
     AND NEW.status IN ('confirmed', 'en_route', 'arrived', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'A closure-held Easer cannot receive or retain a live assignment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_guard_easer_closure_assignment ON public.bookings;
CREATE TRIGGER bookings_guard_easer_closure_assignment
  BEFORE INSERT OR UPDATE OF assembler_id, assembler_accepted_at, status ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_booking_easer_closure_assignment();

REVOKE ALL ON FUNCTION public.guard_booking_easer_closure_assignment()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.request_easer_account_closure(
  p_assembler_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  closure_status TEXT,
  requested_at TIMESTAMPTZ,
  already_requested BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_requested_at TIMESTAMPTZ;
BEGIN
  IF p_assembler_id IS NULL THEN
    RAISE EXCEPTION 'Easer id is required' USING ERRCODE = '22023';
  END IF;
  IF length(COALESCE(p_reason, '')) > 500 THEN
    RAISE EXCEPTION 'Reason must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = p_assembler_id
     AND role = 'assembler'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Easer profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_profile.account_closure_status = 'completed' THEN
    closure_status := 'completed';
    requested_at := v_profile.account_closure_requested_at;
    already_requested := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_profile.account_closure_status IN ('requested', 'reviewing') THEN
    closure_status := v_profile.account_closure_status;
    requested_at := v_profile.account_closure_requested_at;
    already_requested := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.bookings b
     WHERE b.assembler_id = p_assembler_id
       AND b.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'Account closure cannot start while active assignments exist'
      USING ERRCODE = '23514';
  END IF;

  v_requested_at := NOW();
  UPDATE public.profiles
     SET account_closure_requested_at = v_requested_at,
         account_closure_status = 'requested',
         account_closure_reason = NULLIF(BTRIM(COALESCE(p_reason, '')), ''),
         is_available = FALSE
   WHERE id = p_assembler_id;

  closure_status := 'requested';
  requested_at := v_requested_at;
  already_requested := FALSE;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.request_easer_account_closure(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_easer_account_closure(UUID, TEXT)
  TO service_role;

-- Manual payout remains atomic, but refund-affected earnings require an
-- explicit owner review and Connect-snapshotted earnings cannot cross paths.
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
  amount_charged_cents INTEGER;
  net_captured_cents INTEGER;
  remaining_tax_cents INTEGER;
  stripe_fee_cents INTEGER;
  platform_revenue_cents INTEGER;
  expected_operation_key TEXT;
  normalized_method TEXT := LOWER(COALESCE(NULLIF(BTRIM(p_payout_method), ''), 'manual'));
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
  IF booking_row.payout_mode_snapshot IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'This earning is assigned to the Stripe Connect payout path' USING ERRCODE = '22000';
  END IF;
  IF booking_row.damage_review_status = 'review_required' THEN
    RAISE EXCEPTION 'An open damage review must be resolved before payout' USING ERRCODE = '22000';
  END IF;
  IF booking_row.stripe_dispute_hold IS TRUE THEN
    RAISE EXCEPTION 'A Stripe dispute hold must be resolved before payout' USING ERRCODE = '22000';
  END IF;
  IF normalized_method NOT IN ('manual', 'ach', 'zelle', 'paypal', 'check') THEN
    RAISE EXCEPTION 'Unsupported manual payout method: %', normalized_method USING ERRCODE = '22000';
  END IF;

  IF booking_row.status = 'completed' THEN
    IF booking_row.payment_status = 'captured' THEN
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
    canonical_due_cents := COALESCE(booking_row.assembler_due, 0);
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

  amount_charged_cents := COALESCE(booking_row.amount_charged, 0);
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
    platform_revenue, payout_notes, recorded_by, payout_method
  ) VALUES (
    booking_row.id, booking_row.ref, booking_row.assembler_id,
    booking_row.assembler_name, booking_row.assembler_tier, booking_row.service,
    booking_row.date::TEXT, amount_charged_cents, canonical_due_cents,
    canonical_due_cents, platform_revenue_cents, BTRIM(p_notes),
    COALESCE(p_recorded_by, 'owner'), normalized_method
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

-- AssembleCash refund/cancellation reconciliation uses the same normalized
-- email advisory lock as checkout redemption. Reward-source bookings that are
-- refunding, refunded, cancelling, or cancelled never contribute spendable
-- credit, while redeemed ledger rows always remain debits until explicitly
-- released for their own fully reversed booking.
CREATE OR REPLACE FUNCTION public.assemblecash_available_balance(p_email TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(0,
    COALESCE(SUM(ledger.amount_earned_cents) FILTER (
      WHERE ledger.status = 'available'
        AND (ledger.expires_at IS NULL OR ledger.expires_at > NOW())
        AND ledger.amount_earned_cents > 0
        AND source_booking.status = 'completed'
        AND source_booking.payment_status = 'captured'
        AND source_booking.financial_operation_key IS NULL
        AND source_booking.financial_reconciliation_required_at IS NULL
        AND source_booking.assemblecash_earned_cents = ledger.amount_earned_cents
    ), 0)
    - COALESCE(SUM(ledger.amount_redeemed_cents) FILTER (
      WHERE ledger.status = 'redeemed'
    ), 0)
  )::INTEGER
  FROM public.assemblecash_ledger ledger
  LEFT JOIN public.bookings source_booking ON source_booking.id = ledger.booking_id
  WHERE ledger.customer_email = LOWER(BTRIM(COALESCE(p_email, '')));
$$;

CREATE OR REPLACE FUNCTION public.assemblecash_try_redeem(
  p_email TEXT,
  p_amount_cents INTEGER,
  p_booking_ref TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email TEXT := LOWER(BTRIM(COALESCE(p_email, '')));
  v_amount INTEGER := GREATEST(0, COALESCE(p_amount_cents, 0));
  v_available INTEGER := 0;
BEGIN
  IF v_email = '' OR v_amount <= 0 THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 28025));

  SELECT GREATEST(0,
    COALESCE(SUM(ledger.amount_earned_cents) FILTER (
      WHERE ledger.status = 'available'
        AND (ledger.expires_at IS NULL OR ledger.expires_at > NOW())
        AND ledger.amount_earned_cents > 0
        AND source_booking.status = 'completed'
        AND source_booking.payment_status = 'captured'
        AND source_booking.financial_operation_key IS NULL
        AND source_booking.financial_reconciliation_required_at IS NULL
        AND source_booking.assemblecash_earned_cents = ledger.amount_earned_cents
    ), 0)
    - COALESCE(SUM(ledger.amount_redeemed_cents) FILTER (
      WHERE ledger.status = 'redeemed'
    ), 0)
  )::INTEGER
    INTO v_available
    FROM public.assemblecash_ledger ledger
    LEFT JOIN public.bookings source_booking ON source_booking.id = ledger.booking_id
   WHERE ledger.customer_email = v_email;

  IF v_available < v_amount THEN
    RETURN 0;
  END IF;

  INSERT INTO public.assemblecash_ledger (
    customer_email,
    booking_ref,
    amount_redeemed_cents,
    status,
    reason
  ) VALUES (
    v_email,
    NULLIF(BTRIM(COALESCE(p_booking_ref, '')), ''),
    v_amount,
    'redeemed',
    'redeem:booking_pending'
  );

  RETURN v_amount;
END;
$$;

CREATE OR REPLACE FUNCTION public.assemblecash_reconcile_booking_credits(
  p_booking_id UUID,
  p_release_redemption BOOLEAN DEFAULT FALSE,
  p_reason TEXT DEFAULT 'reverse:booking_financial_reversal'
)
RETURNS TABLE (
  reversed_earn_count INTEGER,
  released_redemption_count INTEGER,
  earned_reconciled BOOLEAN,
  redemption_reconciled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_email TEXT;
  v_reversed INTEGER := 0;
  v_released INTEGER := 0;
  v_earned_reconciled BOOLEAN := FALSE;
  v_redemption_reconciled BOOLEAN := FALSE;
  v_reason TEXT := LEFT(COALESCE(NULLIF(BTRIM(p_reason), ''), 'reverse:booking_financial_reversal'), 500);
BEGIN
  SELECT booking.*
    INTO v_booking
    FROM public.bookings booking
   WHERE booking.id = p_booking_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  v_email := LOWER(TRIM(COALESCE(v_booking.customer_email, '')));
  IF v_email = '' THEN
    RAISE EXCEPTION 'Booking has no normalized customer email for AssembleCash reconciliation'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 28025));

  UPDATE public.assemblecash_ledger
     SET status = 'reversed',
         reason = v_reason,
         updated_at = NOW()
   WHERE booking_id = p_booking_id
     AND customer_email = v_email
     AND amount_earned_cents > 0
     AND status = 'available';
  GET DIAGNOSTICS v_reversed = ROW_COUNT;

  IF COALESCE(p_release_redemption, FALSE) THEN
    UPDATE public.assemblecash_ledger
       SET status = 'reversed',
           reason = v_reason,
           updated_at = NOW()
     WHERE booking_id = p_booking_id
       AND customer_email = v_email
       AND amount_redeemed_cents > 0
       AND status = 'redeemed';
    GET DIAGNOSTICS v_released = ROW_COUNT;
  END IF;

  -- A zero row count is valid on an idempotent retry, so verify durable ledger
  -- truth against the booking summary before the API may release its money lock.
  IF COALESCE(v_booking.assemblecash_earned_cents, 0) > 0 THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.assemblecash_ledger ledger
       WHERE ledger.booking_id = p_booking_id
         AND ledger.customer_email = v_email
         AND ledger.amount_earned_cents = v_booking.assemblecash_earned_cents
         AND ledger.amount_earned_cents > 0
         AND ledger.status IN ('reversed', 'expired')
    ) AND NOT EXISTS (
      SELECT 1
        FROM public.assemblecash_ledger ledger
       WHERE ledger.booking_id = p_booking_id
         AND ledger.amount_earned_cents > 0
         AND ledger.status NOT IN ('reversed', 'expired')
    )
      INTO v_earned_reconciled;
  ELSE
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.assemblecash_ledger ledger
       WHERE ledger.booking_id = p_booking_id
         AND ledger.amount_earned_cents > 0
         AND ledger.status NOT IN ('reversed', 'expired')
    )
      INTO v_earned_reconciled;
  END IF;

  IF COALESCE(p_release_redemption, FALSE) THEN
    IF COALESCE(v_booking.assemblecash_redeemed_cents, 0) > 0 THEN
      SELECT COALESCE(SUM(ledger.amount_redeemed_cents), 0) = v_booking.assemblecash_redeemed_cents
             AND COALESCE(BOOL_AND(
               ledger.customer_email = v_email
               AND ledger.status = 'reversed'
             ), FALSE)
        INTO v_redemption_reconciled
        FROM public.assemblecash_ledger ledger
       WHERE ledger.booking_id = p_booking_id
         AND ledger.amount_redeemed_cents > 0;
    ELSE
      SELECT NOT EXISTS (
        SELECT 1
          FROM public.assemblecash_ledger ledger
         WHERE ledger.booking_id = p_booking_id
           AND ledger.amount_redeemed_cents > 0
           AND ledger.status <> 'reversed'
      )
        INTO v_redemption_reconciled;
    END IF;
  ELSE
    v_redemption_reconciled := TRUE;
  END IF;

  RETURN QUERY SELECT
    v_reversed,
    v_released,
    v_earned_reconciled,
    v_redemption_reconciled;
END;
$$;

REVOKE ALL ON FUNCTION public.assemblecash_available_balance(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assemblecash_available_balance(TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.assemblecash_try_redeem(TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assemblecash_try_redeem(TEXT, INTEGER, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.assemblecash_reconcile_booking_credits(UUID, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assemblecash_reconcile_booking_credits(UUID, BOOLEAN, TEXT)
  TO service_role;

-- Owner application decisions cross a Stripe read/write boundary. Persist an
-- exact operation claim on the Easer row so approval and rejection cannot run
-- concurrently, and so a crashed request retries the same idempotent decision.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS application_decision_key TEXT,
  ADD COLUMN IF NOT EXISTS application_decision_type TEXT,
  ADD COLUMN IF NOT EXISTS application_decision_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS application_fee_refunded_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS application_fee_refund_pending_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS application_fee_refund_review_required_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS application_fee_refund_review_reason TEXT,
  ADD COLUMN IF NOT EXISTS application_fee_refund_synced_at TIMESTAMPTZ;

-- Legacy owner rejection only created one completed full refund. Backfill that
-- known state, but stop on contradictory tuples instead of inventing money.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE role = 'assembler'
       AND (
         (application_fee_refunded IS TRUE AND application_fee_refund_id IS NULL)
         OR (application_fee_refunded IS NOT TRUE AND application_fee_refund_id IS NOT NULL)
         OR (application_fee_refunded IS NOT TRUE AND application_fee_refunded_at IS NOT NULL)
       )
  ) THEN
    RAISE EXCEPTION 'Contradictory legacy Easer application-refund rows require owner review before migration 037';
  END IF;
END;
$$;

UPDATE public.profiles
   SET application_fee_refunded_cents = 3000,
       application_fee_refunded_at = COALESCE(application_fee_refunded_at, rejected_at, NOW()),
       application_fee_refund_review_required_at = COALESCE(
         application_fee_refund_review_required_at,
         application_fee_refunded_at,
         rejected_at,
         NOW()
       ),
       application_fee_refund_review_reason = COALESCE(
         application_fee_refund_review_reason,
         'Legacy full application-fee refund'
       ),
       application_fee_refund_synced_at = COALESCE(application_fee_refund_synced_at, NOW())
 WHERE role = 'assembler'
   AND application_fee_refunded IS TRUE
   AND application_fee_refunded_cents = 0;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_application_fee_refund_amount_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_application_fee_refund_amount_check
  CHECK (
    application_fee_refunded_cents BETWEEN 0 AND 3000
    AND application_fee_refund_pending_cents BETWEEN 0 AND 3000
    AND application_fee_refunded_cents + application_fee_refund_pending_cents <= 3000
  );

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_application_fee_refund_truth_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_application_fee_refund_truth_check
  CHECK (
    (
      application_fee_refunded_cents = 0
      AND application_fee_refunded IS NOT TRUE
      AND application_fee_refund_id IS NULL
      AND application_fee_refunded_at IS NULL
    )
    OR (
      application_fee_refunded_cents > 0
      AND application_fee_refunded IS TRUE
      AND NULLIF(BTRIM(application_fee_refund_id), '') IS NOT NULL
      AND application_fee_refunded_at IS NOT NULL
      AND application_fee_refund_review_required_at IS NOT NULL
    )
  );

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_application_fee_refund_review_reason_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_application_fee_refund_review_reason_check
  CHECK (
    application_fee_refund_review_reason IS NULL
    OR (
      NULLIF(BTRIM(application_fee_refund_review_reason), '') IS NOT NULL
      AND length(application_fee_refund_review_reason) <= 1000
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE role = 'assembler'
       AND stripe_payment_intent_id IS NOT NULL
     GROUP BY stripe_payment_intent_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Easer application PaymentIntent links require owner review before migration 037';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_easer_application_payment_intent_unique
  ON public.profiles(stripe_payment_intent_id)
  WHERE role = 'assembler' AND stripe_payment_intent_id IS NOT NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_application_decision_tuple_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_application_decision_tuple_check
  CHECK (
    (
      application_decision_key IS NULL
      AND application_decision_type IS NULL
      AND application_decision_started_at IS NULL
    )
    OR (
      NULLIF(BTRIM(application_decision_key), '') IS NOT NULL
      AND length(application_decision_key) <= 240
      AND application_decision_type IN ('approve', 'reject')
      AND application_decision_started_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_application_decision_key_unique
  ON public.profiles(application_decision_key)
  WHERE application_decision_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.easer_application_decision_snapshot(
  p_profile public.profiles
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'status', p_profile.status,
    'application_status', p_profile.application_status,
    'tier', p_profile.tier,
    'is_available', p_profile.is_available IS TRUE,
    'identity_verified', p_profile.identity_verified IS TRUE,
    'contractor_agreement_signed', p_profile.contractor_agreement_signed_at IS NOT NULL,
    'contractor_agreement_version', p_profile.contractor_agreement_version,
    'code_of_conduct_accepted', p_profile.code_of_conduct_agreed_at IS NOT NULL,
    'phone', BTRIM(COALESCE(p_profile.phone, '')),
    'application_fee_paid', p_profile.application_fee_paid IS TRUE,
    'payment_confirmed', p_profile.payment_confirmed IS TRUE,
    'application_fee_waived', p_profile.application_fee_waived IS TRUE,
    'fee_waived_by_owner', p_profile.fee_waived_by_owner IS TRUE,
    'application_fee_refunded', p_profile.application_fee_refunded IS TRUE,
    'application_fee_refunded_cents', COALESCE(p_profile.application_fee_refunded_cents, 0),
    'application_fee_refund_pending_cents', COALESCE(p_profile.application_fee_refund_pending_cents, 0),
    'application_fee_refund_review_required_at_present', p_profile.application_fee_refund_review_required_at IS NOT NULL,
    'application_fee_refund_review_reason', p_profile.application_fee_refund_review_reason,
    'application_fee_refund_id', p_profile.application_fee_refund_id,
    'application_fee_refunded_at_present', p_profile.application_fee_refunded_at IS NOT NULL,
    'stripe_payment_intent_id', p_profile.stripe_payment_intent_id,
    'stripe_customer_id', p_profile.stripe_customer_id,
    'account_closure_status', p_profile.account_closure_status,
    'approved_at_present', p_profile.approved_at IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.easer_application_decision_snapshot(public.profiles)
  FROM PUBLIC, anon, authenticated, service_role;

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
       OR v_profile.application_status IS DISTINCT FROM 'applied'
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

REVOKE ALL ON FUNCTION public.claim_easer_application_decision(UUID, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_easer_application_decision(UUID, TEXT, TEXT, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.release_easer_application_decision(
  p_assembler_id UUID,
  p_decision TEXT,
  p_operation_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF p_assembler_id IS NULL
     OR LOWER(BTRIM(COALESCE(p_decision, ''))) NOT IN ('approve', 'reject')
     OR BTRIM(COALESCE(p_operation_key, '')) = '' THEN
    RAISE EXCEPTION 'Invalid Easer application decision release'
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

  IF v_profile.application_decision_type = LOWER(BTRIM(p_decision))
     AND v_profile.application_decision_key = BTRIM(p_operation_key) THEN
    UPDATE public.profiles
       SET application_decision_key = NULL,
           application_decision_type = NULL,
           application_decision_started_at = NULL
     WHERE id = p_assembler_id;
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.release_easer_application_decision(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_easer_application_decision(UUID, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_easer_application_decision(
  p_assembler_id UUID,
  p_decision TEXT,
  p_operation_key TEXT,
  p_expected_snapshot JSONB,
  p_required_agreement_version TEXT,
  p_refund_id TEXT DEFAULT NULL,
  p_refunded_at TIMESTAMPTZ DEFAULT NULL,
  p_rejection_reason TEXT DEFAULT NULL,
  p_decided_at TIMESTAMPTZ DEFAULT NULL
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
     OR length(COALESCE(p_rejection_reason, '')) > 2000 THEN
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
    IF v_paid_mode THEN
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
  UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_easer_application_decision(
  UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ
) TO service_role;

-- A customer dispute is a money-loss hold, independent of booking status.
-- Persist it under a booking row lock before any manual or Connect payout can
-- be considered. Webhooks never clear this hold from a stale lifecycle event.
CREATE OR REPLACE FUNCTION public.hold_booking_stripe_dispute(
  p_booking_id UUID,
  p_payment_intent_id TEXT,
  p_charge_id TEXT,
  p_dispute_id TEXT,
  p_dispute_status TEXT,
  p_dispute_amount_cents INTEGER,
  p_currency TEXT,
  p_dispute_reason TEXT,
  p_livemode BOOLEAN,
  p_funds_withdrawn BOOLEAN,
  p_funds_reinstated BOOLEAN,
  p_observed_at TIMESTAMPTZ
)
RETURNS TABLE (
  result_action TEXT,
  booking_ref TEXT,
  customer_name TEXT,
  customer_email TEXT,
  payout_status TEXT,
  assembler_id UUID,
  financial_operation_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_dispute_id TEXT := NULLIF(BTRIM(COALESCE(p_dispute_id, '')), '');
  v_dispute_status TEXT := LOWER(NULLIF(BTRIM(COALESCE(p_dispute_status, '')), ''));
  v_reason TEXT := NULLIF(BTRIM(COALESCE(p_dispute_reason, '')), '');
  v_existing_booking_id UUID;
  v_changed BOOLEAN;
BEGIN
  IF p_booking_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_payment_intent_id, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_charge_id, '')), '') IS NULL
     OR v_dispute_id IS NULL
     OR v_dispute_status IS NULL
     OR length(v_dispute_status) > 100
     OR p_dispute_amount_cents IS NULL
     OR p_dispute_amount_cents <= 0
     OR LOWER(BTRIM(COALESCE(p_currency, ''))) <> 'usd'
     OR p_livemode IS NULL
     OR p_funds_withdrawn IS NULL
     OR p_funds_reinstated IS NULL
     OR p_observed_at IS NULL
     OR length(COALESCE(v_reason, '')) > 500 THEN
    RAISE EXCEPTION 'Invalid booking Stripe dispute hold'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  IF BTRIM(p_payment_intent_id) IS DISTINCT FROM v_booking.stripe_payment_intent_id
     AND BTRIM(p_payment_intent_id) IS DISTINCT FROM v_booking.stripe_deposit_intent_id
     AND BTRIM(p_payment_intent_id) IS DISTINCT FROM v_booking.stripe_balance_payment_intent_id THEN
    RAISE EXCEPTION 'Stripe dispute PaymentIntent does not match the booking'
      USING ERRCODE = '23514';
  END IF;

  SELECT booking_id INTO v_existing_booking_id
    FROM public.booking_stripe_disputes
   WHERE dispute_id = v_dispute_id;
  IF FOUND AND v_existing_booking_id IS DISTINCT FROM p_booking_id THEN
    RAISE EXCEPTION 'Stripe dispute is already linked to another booking'
      USING ERRCODE = '23514';
  END IF;

  v_changed := v_booking.stripe_dispute_hold IS NOT TRUE
    OR v_booking.stripe_dispute_id IS DISTINCT FROM v_dispute_id
    OR v_booking.stripe_dispute_status IS DISTINCT FROM v_dispute_status
    OR v_booking.stripe_dispute_amount_cents IS DISTINCT FROM p_dispute_amount_cents;

  INSERT INTO public.booking_stripe_disputes (
    dispute_id, booking_id, payment_intent_id, charge_id, status,
    amount_cents, currency, reason, livemode, blocking, opened_at, updated_at,
    funds_withdrawn_at, funds_reinstated_at, resolved_at
  ) VALUES (
    v_dispute_id, p_booking_id, BTRIM(p_payment_intent_id), BTRIM(p_charge_id),
    v_dispute_status, p_dispute_amount_cents, 'usd', v_reason, p_livemode,
    NOT (
      v_dispute_status IN ('warning_closed', 'prevented')
      OR (v_dispute_status = 'won' AND p_funds_reinstated)
    ),
    p_observed_at, p_observed_at,
    CASE WHEN p_funds_withdrawn THEN p_observed_at ELSE NULL END,
    CASE WHEN p_funds_reinstated THEN p_observed_at ELSE NULL END,
    CASE
      WHEN v_dispute_status IN ('warning_closed', 'prevented')
        OR (v_dispute_status = 'won' AND p_funds_reinstated)
        THEN p_observed_at
      ELSE NULL
    END
  )
  ON CONFLICT (dispute_id) DO UPDATE
     SET payment_intent_id = EXCLUDED.payment_intent_id,
         charge_id = EXCLUDED.charge_id,
         status = EXCLUDED.status,
         amount_cents = EXCLUDED.amount_cents,
         currency = EXCLUDED.currency,
         reason = EXCLUDED.reason,
         livemode = EXCLUDED.livemode,
         opened_at = LEAST(public.booking_stripe_disputes.opened_at, EXCLUDED.opened_at),
         updated_at = GREATEST(public.booking_stripe_disputes.updated_at, EXCLUDED.updated_at),
         funds_withdrawn_at = COALESCE(
           public.booking_stripe_disputes.funds_withdrawn_at,
           EXCLUDED.funds_withdrawn_at
         ),
         funds_reinstated_at = COALESCE(
           public.booking_stripe_disputes.funds_reinstated_at,
           EXCLUDED.funds_reinstated_at
         ),
         blocking = NOT (
           EXCLUDED.status IN ('warning_closed', 'prevented')
           OR (
             EXCLUDED.status = 'won'
             AND COALESCE(
               public.booking_stripe_disputes.funds_reinstated_at,
               EXCLUDED.funds_reinstated_at
             ) IS NOT NULL
           )
         ),
         resolved_at = CASE
           WHEN EXCLUDED.status IN ('warning_closed', 'prevented')
             OR (
               EXCLUDED.status = 'won'
               AND COALESCE(
                 public.booking_stripe_disputes.funds_reinstated_at,
                 EXCLUDED.funds_reinstated_at
               ) IS NOT NULL
             )
             THEN COALESCE(public.booking_stripe_disputes.resolved_at, EXCLUDED.updated_at)
           ELSE NULL
         END;

  UPDATE public.bookings
     SET stripe_dispute_hold = TRUE,
         stripe_dispute_id = v_dispute_id,
         stripe_dispute_status = v_dispute_status,
         stripe_dispute_amount_cents = p_dispute_amount_cents,
         stripe_dispute_reason = v_reason,
         stripe_dispute_opened_at = COALESCE(stripe_dispute_opened_at, p_observed_at),
         stripe_dispute_updated_at = GREATEST(
           COALESCE(stripe_dispute_updated_at, p_observed_at),
           p_observed_at
         ),
         payout_review_status = 'review_required',
         payout_reviewed_at = NULL,
         payout_reviewed_by = NULL,
         payout_review_notes = NULL,
         dispatch_paused = CASE
           WHEN status = 'confirmed' AND assembler_id IS NULL THEN TRUE
           ELSE dispatch_paused
         END,
         needs_manual_dispatch = CASE
           WHEN status = 'confirmed' AND assembler_id IS NULL THEN TRUE
           ELSE needs_manual_dispatch
         END,
         dispatch_status = CASE
           WHEN status = 'confirmed' AND assembler_id IS NULL THEN 'payment_hold'
           ELSE dispatch_status
         END
   WHERE id = p_booking_id;

  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id;
  RETURN QUERY SELECT
    CASE WHEN v_changed THEN 'held'::TEXT ELSE 'unchanged'::TEXT END,
    v_booking.ref::TEXT,
    v_booking.customer_name::TEXT,
    v_booking.customer_email::TEXT,
    v_booking.payout_status::TEXT,
    v_booking.assembler_id,
    v_booking.financial_operation_type::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.hold_booking_stripe_dispute(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hold_booking_stripe_dispute(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TIMESTAMPTZ
) TO service_role;

CREATE OR REPLACE FUNCTION public.clear_booking_stripe_dispute_hold(
  p_booking_id UUID,
  p_dispute_id TEXT,
  p_live_status TEXT,
  p_resolved_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_status TEXT := LOWER(BTRIM(COALESCE(p_live_status, '')));
BEGIN
  IF p_booking_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_dispute_id, '')), '') IS NULL
     OR v_status NOT IN ('won', 'warning_closed', 'prevented')
     OR p_resolved_at IS NULL THEN
    RAISE EXCEPTION 'Fresh won/closed Stripe dispute truth is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_booking.stripe_dispute_hold IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1
         FROM public.booking_stripe_disputes d
        WHERE d.booking_id = p_booking_id
          AND d.dispute_id = BTRIM(p_dispute_id)
          AND d.status = v_status
          AND d.blocking IS FALSE
          AND (
            d.status IN ('warning_closed', 'prevented')
            OR (d.status = 'won' AND d.funds_reinstated_at IS NOT NULL)
          )
     ) THEN
    RAISE EXCEPTION 'Stripe dispute hold changed before resolution'
      USING ERRCODE = '40001';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'A booking financial operation is in progress'
      USING ERRCODE = '55P03';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.booking_stripe_disputes d
     WHERE d.booking_id = p_booking_id
       AND d.blocking IS TRUE
  ) THEN
    RAISE EXCEPTION 'Another Stripe dispute still blocks this booking payout'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.bookings
     SET stripe_dispute_hold = FALSE,
         payout_review_status = CASE
           WHEN payment_status IN ('partially_refunded', 'refunded') THEN 'review_required'
           ELSE 'not_required'
         END,
         payout_reviewed_at = NULL,
         payout_reviewed_by = NULL,
         payout_review_notes = NULL
   WHERE id = p_booking_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_booking_stripe_dispute_hold(
  UUID, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.clear_booking_stripe_dispute_hold(
  UUID, TEXT, TEXT, TIMESTAMPTZ
) TO service_role;

-- A signed Stripe refund event first takes an exact, durable offline hold. This
-- happens before remote pagination/shape validation so malformed or truncated
-- Stripe truth can never leave an Easer eligible for new work.
CREATE OR REPLACE FUNCTION public.hold_easer_application_fee_refund(
  p_assembler_id UUID,
  p_payment_intent_id TEXT,
  p_observed_at TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS TABLE (
  result_action TEXT,
  profile_status TEXT,
  profile_application_status TEXT,
  profile_is_available BOOLEAN,
  refunded_cents INTEGER,
  pending_refund_cents INTEGER,
  refund_id TEXT,
  review_required_at TIMESTAMPTZ,
  profile_full_name TEXT,
  profile_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_reason TEXT := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
  v_changed BOOLEAN;
BEGIN
  IF p_assembler_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_payment_intent_id, '')), '') IS NULL
     OR p_observed_at IS NULL
     OR v_reason IS NULL
     OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Invalid Easer application-fee refund hold'
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
  IF v_profile.stripe_payment_intent_id IS DISTINCT FROM BTRIM(p_payment_intent_id) THEN
    RAISE EXCEPTION 'Application-fee refund PaymentIntent does not match the Easer'
      USING ERRCODE = '23514';
  END IF;

  v_changed := v_profile.is_available IS TRUE
    OR v_profile.application_fee_refund_review_required_at IS NULL
    OR v_profile.application_fee_refund_review_reason IS DISTINCT FROM v_reason
    OR v_profile.application_decision_type = 'approve';

  UPDATE public.profiles
     SET is_available = FALSE,
         application_fee_refund_review_required_at = COALESCE(
           application_fee_refund_review_required_at,
           p_observed_at
         ),
         application_fee_refund_review_reason = v_reason,
         application_fee_refund_synced_at = GREATEST(
           COALESCE(application_fee_refund_synced_at, p_observed_at),
           p_observed_at
         ),
         application_decision_key = CASE
           WHEN application_decision_type = 'approve' THEN NULL
           ELSE application_decision_key
         END,
         application_decision_type = CASE
           WHEN application_decision_type = 'approve' THEN NULL
           ELSE application_decision_type
         END,
         application_decision_started_at = CASE
           WHEN application_decision_type = 'approve' THEN NULL
           ELSE application_decision_started_at
         END
   WHERE id = p_assembler_id;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_assembler_id;
  RETURN QUERY SELECT
    CASE WHEN v_changed THEN 'held'::TEXT ELSE 'unchanged'::TEXT END,
    v_profile.status,
    v_profile.application_status,
    v_profile.is_available,
    v_profile.application_fee_refunded_cents,
    v_profile.application_fee_refund_pending_cents,
    v_profile.application_fee_refund_id,
    v_profile.application_fee_refund_review_required_at,
    v_profile.full_name,
    v_profile.email;
END;
$$;

REVOKE ALL ON FUNCTION public.hold_easer_application_fee_refund(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hold_easer_application_fee_refund(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) TO service_role;

-- Persist only a complete, freshly validated Stripe aggregate. Succeeded cents
-- are monotonic; pending cents may resolve, but a refund hold never silently
-- restores availability. Approval claims are invalidated, while an exact owner
-- rejection claim is preserved so it can finish idempotently.
CREATE OR REPLACE FUNCTION public.reconcile_easer_application_fee_refund(
  p_assembler_id UUID,
  p_payment_intent_id TEXT,
  p_stripe_customer_id TEXT,
  p_succeeded_refunded_cents INTEGER,
  p_pending_refund_cents INTEGER,
  p_latest_succeeded_refund_id TEXT,
  p_latest_succeeded_refunded_at TIMESTAMPTZ,
  p_observed_at TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS TABLE (
  result_action TEXT,
  profile_status TEXT,
  profile_application_status TEXT,
  profile_is_available BOOLEAN,
  refunded_cents INTEGER,
  pending_refund_cents INTEGER,
  refund_id TEXT,
  review_required_at TIMESTAMPTZ,
  profile_full_name TEXT,
  profile_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_reason TEXT := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
  v_refund_id TEXT := NULLIF(BTRIM(COALESCE(p_latest_succeeded_refund_id, '')), '');
  v_has_live_activity BOOLEAN;
  v_changed BOOLEAN;
BEGIN
  IF p_assembler_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_payment_intent_id, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_stripe_customer_id, '')), '') IS NULL
     OR p_succeeded_refunded_cents IS NULL
     OR p_pending_refund_cents IS NULL
     OR p_succeeded_refunded_cents < 0
     OR p_pending_refund_cents < 0
     OR p_succeeded_refunded_cents + p_pending_refund_cents > 3000
     OR p_observed_at IS NULL
     OR v_reason IS NULL
     OR length(v_reason) > 1000
     OR (
       p_succeeded_refunded_cents = 0
       AND (v_refund_id IS NOT NULL OR p_latest_succeeded_refunded_at IS NOT NULL)
     )
     OR (
       p_succeeded_refunded_cents > 0
       AND (v_refund_id IS NULL OR p_latest_succeeded_refunded_at IS NULL)
     ) THEN
    RAISE EXCEPTION 'Invalid Easer application-fee refund aggregate'
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
  IF v_profile.stripe_payment_intent_id IS DISTINCT FROM BTRIM(p_payment_intent_id)
     OR v_profile.stripe_customer_id IS DISTINCT FROM BTRIM(p_stripe_customer_id) THEN
    RAISE EXCEPTION 'Application-fee refund Stripe identifiers do not match the Easer'
      USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_profile.application_fee_refunded_cents, 0) > p_succeeded_refunded_cents THEN
    RAISE EXCEPTION 'Fresh Stripe refund aggregate cannot regress stored succeeded cents'
      USING ERRCODE = '40001';
  END IF;

  v_has_live_activity := p_succeeded_refunded_cents > 0 OR p_pending_refund_cents > 0;
  IF v_profile.application_fee_waived IS TRUE
     OR v_profile.fee_waived_by_owner IS TRUE THEN
    RAISE EXCEPTION 'A waived application cannot contain a succeeded Stripe application fee'
      USING ERRCODE = '23514';
  END IF;

  v_changed := v_profile.application_fee_refunded_cents IS DISTINCT FROM p_succeeded_refunded_cents
    OR v_profile.application_fee_refund_pending_cents IS DISTINCT FROM p_pending_refund_cents
    OR (
      p_succeeded_refunded_cents > 0
      AND v_profile.application_fee_refund_id IS DISTINCT FROM v_refund_id
    )
    OR (v_has_live_activity AND v_profile.application_fee_refund_review_required_at IS NULL)
    OR (v_has_live_activity AND v_profile.is_available IS TRUE)
    OR (v_has_live_activity AND v_profile.application_decision_type = 'approve');

  UPDATE public.profiles
     SET payment_confirmed = TRUE,
         application_fee_paid = TRUE,
         is_available = CASE
           WHEN v_has_live_activity OR application_fee_refund_review_required_at IS NOT NULL
             THEN FALSE
           ELSE is_available
         END,
         application_fee_refunded_cents = p_succeeded_refunded_cents,
         application_fee_refund_pending_cents = p_pending_refund_cents,
         application_fee_refunded = p_succeeded_refunded_cents > 0,
         application_fee_refund_id = CASE
           WHEN p_succeeded_refunded_cents > 0 THEN v_refund_id
           ELSE NULL
         END,
         application_fee_refunded_at = CASE
           WHEN p_succeeded_refunded_cents > 0 THEN p_latest_succeeded_refunded_at
           ELSE NULL
         END,
         application_fee_refund_review_required_at = CASE
           WHEN v_has_live_activity THEN COALESCE(
             application_fee_refund_review_required_at,
             p_observed_at
           )
           ELSE application_fee_refund_review_required_at
         END,
         application_fee_refund_review_reason = CASE
           WHEN v_has_live_activity OR application_fee_refund_review_required_at IS NOT NULL
             THEN v_reason
           ELSE application_fee_refund_review_reason
         END,
         application_fee_refund_synced_at = GREATEST(
           COALESCE(application_fee_refund_synced_at, p_observed_at),
           p_observed_at
         ),
         application_decision_key = CASE
           WHEN v_has_live_activity AND application_decision_type = 'approve' THEN NULL
           ELSE application_decision_key
         END,
         application_decision_type = CASE
           WHEN v_has_live_activity AND application_decision_type = 'approve' THEN NULL
           ELSE application_decision_type
         END,
         application_decision_started_at = CASE
           WHEN v_has_live_activity AND application_decision_type = 'approve' THEN NULL
           ELSE application_decision_started_at
         END
   WHERE id = p_assembler_id;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_assembler_id;
  RETURN QUERY SELECT
    CASE WHEN v_changed THEN 'reconciled'::TEXT ELSE 'unchanged'::TEXT END,
    v_profile.status,
    v_profile.application_status,
    v_profile.is_available,
    v_profile.application_fee_refunded_cents,
    v_profile.application_fee_refund_pending_cents,
    v_profile.application_fee_refund_id,
    v_profile.application_fee_refund_review_required_at,
    v_profile.full_name,
    v_profile.email;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_easer_application_fee_refund(
  UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_easer_application_fee_refund(
  UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) TO service_role;

-- Owner-only recovery after fresh Stripe proof shows no pending/succeeded
-- refund and no unresolved dispute. Clearing the financial hold never puts the
-- Easer online; availability remains an explicit later owner/Easer decision.
CREATE OR REPLACE FUNCTION public.clear_easer_application_fee_financial_hold(
  p_assembler_id UUID,
  p_payment_intent_id TEXT,
  p_stripe_customer_id TEXT,
  p_expected_review_required_at TIMESTAMPTZ,
  p_cleared_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF p_assembler_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_payment_intent_id, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_stripe_customer_id, '')), '') IS NULL
     OR p_expected_review_required_at IS NULL
     OR p_cleared_at IS NULL THEN
    RAISE EXCEPTION 'Invalid application-fee financial-hold clearance'
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
  IF v_profile.stripe_payment_intent_id IS DISTINCT FROM BTRIM(p_payment_intent_id)
     OR v_profile.stripe_customer_id IS DISTINCT FROM BTRIM(p_stripe_customer_id)
     OR v_profile.application_fee_refund_review_required_at IS DISTINCT FROM p_expected_review_required_at THEN
    RAISE EXCEPTION 'Application-fee financial hold changed before clearance'
      USING ERRCODE = '40001';
  END IF;
  IF v_profile.application_fee_refunded IS TRUE
     OR COALESCE(v_profile.application_fee_refunded_cents, 0) <> 0
     OR COALESCE(v_profile.application_fee_refund_pending_cents, 0) <> 0
     OR v_profile.application_fee_refund_id IS NOT NULL
     OR v_profile.application_fee_refunded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Succeeded or pending application-fee refunds cannot be cleared'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.profiles
     SET application_fee_refund_review_required_at = NULL,
         application_fee_refund_review_reason = NULL,
         application_fee_refund_synced_at = p_cleared_at,
         is_available = FALSE
   WHERE id = p_assembler_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_easer_application_fee_financial_hold(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.clear_easer_application_fee_financial_hold(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

-- Replace migration 034's fee transition guard. A Stripe refund may revoke
-- new-job readiness on an already active Easer only as an atomic offline hold;
-- the profile remains active/approved so accepted work is not stranded.
CREATE OR REPLACE FUNCTION public.guard_easer_fee_readiness_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entering_ready_state BOOLEAN := FALSE;
  v_revoking_ready_fee BOOLEAN := FALSE;
  v_old_fee_satisfied BOOLEAN := FALSE;
  v_fee_satisfied BOOLEAN;
  v_exact_refund_hold_transition BOOLEAN := FALSE;
BEGIN
  IF NEW.role IS DISTINCT FROM 'assembler' THEN
    RETURN NEW;
  END IF;

  v_fee_satisfied := NEW.application_fee_refunded IS NOT TRUE
    AND COALESCE(NEW.application_fee_refunded_cents, 0) = 0
    AND COALESCE(NEW.application_fee_refund_pending_cents, 0) = 0
    AND NEW.application_fee_refund_review_required_at IS NULL
    AND (
      NEW.application_fee_paid IS TRUE
      OR NEW.application_fee_waived IS TRUE
      OR NEW.fee_waived_by_owner IS TRUE
    );

  IF TG_OP = 'INSERT' THEN
    v_entering_ready_state := (
      NEW.status = 'active'
      OR NEW.application_status = 'approved'
      OR NEW.is_available IS TRUE
    );
  ELSE
    v_old_fee_satisfied := OLD.application_fee_refunded IS NOT TRUE
      AND COALESCE(OLD.application_fee_refunded_cents, 0) = 0
      AND COALESCE(OLD.application_fee_refund_pending_cents, 0) = 0
      AND OLD.application_fee_refund_review_required_at IS NULL
      AND (
        OLD.application_fee_paid IS TRUE
        OR OLD.application_fee_waived IS TRUE
        OR OLD.fee_waived_by_owner IS TRUE
      );
    v_entering_ready_state := (
      (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
      OR (NEW.application_status = 'approved' AND OLD.application_status IS DISTINCT FROM 'approved')
      OR (NEW.is_available IS TRUE AND OLD.is_available IS NOT TRUE)
    );
    v_revoking_ready_fee := (
      (NEW.status = 'active' OR NEW.application_status = 'approved' OR NEW.is_available IS TRUE)
      AND v_old_fee_satisfied
      AND NOT v_fee_satisfied
    );
    v_exact_refund_hold_transition := (
      NEW.is_available IS FALSE
      AND NEW.application_fee_refund_review_required_at IS NOT NULL
      AND NEW.application_fee_paid IS NOT DISTINCT FROM OLD.application_fee_paid
      AND NEW.application_fee_waived IS NOT DISTINCT FROM OLD.application_fee_waived
      AND NEW.fee_waived_by_owner IS NOT DISTINCT FROM OLD.fee_waived_by_owner
      AND COALESCE(NEW.application_fee_refunded_cents, 0)
        >= COALESCE(OLD.application_fee_refunded_cents, 0)
      AND COALESCE(NEW.application_fee_refund_pending_cents, 0) >= 0
      AND NEW.application_fee_refunded
        IS NOT DISTINCT FROM (COALESCE(NEW.application_fee_refunded_cents, 0) > 0)
    );
  END IF;

  IF v_entering_ready_state AND NOT v_fee_satisfied THEN
    RAISE EXCEPTION 'Application fee must be paid or explicitly waived before Easer readiness'
      USING ERRCODE = '23514';
  END IF;
  IF v_revoking_ready_fee AND NOT v_exact_refund_hold_transition THEN
    RAISE EXCEPTION 'Application fee readiness can only be revoked by an offline refund hold'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_easer_fee_readiness_transition()
  FROM PUBLIC, anon, authenticated;

-- Assigned-job messaging is an operational-work capability, not new-job
-- readiness. A consistent paid/refund-held Easer may message only a booking
-- still assigned to their own auth user.
CREATE OR REPLACE FUNCTION public.can_read_easer_booking_messages(p_booking_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.bookings b
      JOIN public.profiles p ON p.id = auth.uid()
     WHERE b.id = p_booking_id
       AND b.assembler_id = auth.uid()
       AND p.role = 'assembler'
       AND p.status = 'active'
       AND p.application_status = 'approved'
       AND p.tier IN ('starter', 'professional', 'elite', 'verified')
       AND p.identity_verified IS TRUE
       AND p.contractor_agreement_signed_at IS NOT NULL
       AND p.code_of_conduct_agreed_at IS NOT NULL
       AND COALESCE(p.account_closure_status, '') NOT IN ('requested', 'reviewing', 'completed')
       AND (
         (
           p.application_fee_refunded IS NOT TRUE
           AND COALESCE(p.application_fee_refunded_cents, 0) = 0
           AND COALESCE(p.application_fee_refund_pending_cents, 0) = 0
           AND p.application_fee_refund_review_required_at IS NULL
           AND (
             p.application_fee_paid IS TRUE
             OR p.application_fee_waived IS TRUE
             OR p.fee_waived_by_owner IS TRUE
           )
         )
         OR (
           p.application_fee_paid IS TRUE
           AND p.payment_confirmed IS TRUE
           AND (
             p.application_fee_refunded IS TRUE
             OR COALESCE(p.application_fee_refunded_cents, 0) > 0
             OR COALESCE(p.application_fee_refund_pending_cents, 0) > 0
             OR p.application_fee_refund_review_required_at IS NOT NULL
           )
         )
       )
  );
$$;

REVOKE ALL ON FUNCTION public.can_read_easer_booking_messages(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_easer_booking_messages(UUID)
  TO authenticated;

-- A claimed rejection may accept payment/refund reconciliation updates, but it
-- may never be bypassed by a direct activation. The inverse protects a claimed
-- approval from a direct rejection while its exact final CAS is outstanding.
CREATE OR REPLACE FUNCTION public.guard_easer_application_decision_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM 'assembler' THEN
    RETURN NEW;
  END IF;

  IF OLD.application_decision_type = 'reject'
     AND (
       NEW.status = 'active'
       OR NEW.application_status = 'approved'
       OR NEW.is_available IS TRUE
     ) THEN
    RAISE EXCEPTION 'A claimed application rejection blocks Easer activation'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.application_decision_type = 'approve'
     AND (
       NEW.status = 'rejected'
       OR NEW.application_status = 'rejected'
     ) THEN
    RAISE EXCEPTION 'A claimed application approval blocks direct rejection'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.application_decision_type = 'reject'
     AND (
       NEW.status = 'active'
       OR NEW.application_status = 'approved'
       OR NEW.is_available IS TRUE
     ) THEN
    RAISE EXCEPTION 'A rejection claim cannot coexist with active Easer access'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_easer_application_decision ON public.profiles;
CREATE TRIGGER profiles_guard_easer_application_decision
  BEFORE UPDATE OF status, application_status, is_available,
    application_decision_key, application_decision_type, application_decision_started_at
  ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_easer_application_decision_transition();

REVOKE ALL ON FUNCTION public.guard_easer_application_decision_transition()
  FROM PUBLIC, anon, authenticated;

-- Replace the earlier closure-only guard with the complete manual-payout
-- readiness contract. The profile row lock serializes assignment/acceptance
-- with suspension and closure while retaining explicit zero-dollar simulation.
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
BEGIN
  IF NEW.assembler_id IS NULL THEN
    RETURN NEW;
  END IF;

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

  v_payment_guard_required := v_assignment_started
    OR (
      TG_OP = 'UPDATE'
      AND NEW.status IS DISTINCT FROM OLD.status
      AND NEW.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')
    );
  v_readiness_guard_required := v_assignment_started
    OR (
      TG_OP = 'UPDATE'
      AND NEW.status = 'confirmed'
      AND OLD.status IS DISTINCT FROM 'confirmed'
    );

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

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = NEW.assembler_id
     AND role = 'assembler'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned Easer profile not found' USING ERRCODE = '23503';
  END IF;

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
    assignment_token, status ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_booking_easer_closure_assignment();

REVOKE ALL ON FUNCTION public.guard_booking_easer_closure_assignment()
  FROM PUBLIC, anon, authenticated;

-- New offers carry customer job information and an acceptance capability.
-- Lock the exact profile before a sent offer is created so a concurrent refund
-- hold and dispatch cannot both commit as successful readiness decisions.
CREATE OR REPLACE FUNCTION public.guard_dispatch_offer_easer_readiness()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_entering_sent BOOLEAN;
BEGIN
  v_entering_sent := NEW.offer_status = 'sent'
    AND (
      TG_OP = 'INSERT'
      OR OLD.offer_status IS DISTINCT FROM 'sent'
      OR OLD.easer_id IS DISTINCT FROM NEW.easer_id
    );
  IF NOT v_entering_sent THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = NEW.booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch-offer booking not found'
      USING ERRCODE = '23503';
  END IF;
  IF v_booking.stripe_dispute_hold IS TRUE
     OR v_booking.status IS DISTINCT FROM 'confirmed'
     OR v_booking.assembler_id IS NOT NULL THEN
    RAISE EXCEPTION 'A held or unavailable booking cannot receive a dispatch offer'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = NEW.easer_id
     AND role = 'assembler'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch-offer Easer profile not found'
      USING ERRCODE = '23503';
  END IF;

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
    RAISE EXCEPTION 'Dispatch-offer Easer is not ready and eligible for jobs'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dispatch_offers_guard_easer_readiness ON public.dispatch_offers;
CREATE TRIGGER dispatch_offers_guard_easer_readiness
  BEFORE INSERT OR UPDATE OF easer_id, offer_status ON public.dispatch_offers
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_dispatch_offer_easer_readiness();

REVOKE ALL ON FUNCTION public.guard_dispatch_offer_easer_readiness()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.suspend_easer_if_no_active_jobs(
  p_assembler_id UUID,
  p_expected_status TEXT,
  p_expected_tier TEXT
)
RETURNS TABLE (
  result_action TEXT,
  previous_tier TEXT,
  active_jobs JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_active_jobs JSONB;
  v_previous_tier TEXT;
BEGIN
  IF p_assembler_id IS NULL THEN
    RAISE EXCEPTION 'Easer id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = p_assembler_id
     AND role = 'assembler'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Easer profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_profile.status = 'suspended' OR v_profile.tier = 'suspended' THEN
    RETURN QUERY SELECT 'already_suspended'::TEXT, v_profile.previous_tier,
      '[]'::JSONB;
    RETURN;
  END IF;
  IF v_profile.status IS DISTINCT FROM p_expected_status
     OR v_profile.tier IS DISTINCT FROM p_expected_tier THEN
    RAISE EXCEPTION 'Easer state changed before suspension'
      USING ERRCODE = '40001';
  END IF;
  IF v_profile.status IS DISTINCT FROM 'active'
     OR v_profile.application_decision_key IS NOT NULL THEN
    RAISE EXCEPTION 'Only an active Easer without an application decision can be suspended'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'ref', b.ref,
        'service', b.service,
        'date', b.date
      ) ORDER BY b.date NULLS LAST, b.ref
    ),
    '[]'::JSONB
  ) INTO v_active_jobs
    FROM public.bookings b
   WHERE b.assembler_id = p_assembler_id
     AND b.status IN ('confirmed', 'en_route', 'arrived', 'in_progress');

  IF jsonb_array_length(v_active_jobs) > 0 THEN
    RETURN QUERY SELECT 'active_jobs'::TEXT, NULL::TEXT, v_active_jobs;
    RETURN;
  END IF;

  v_previous_tier := CASE
    WHEN v_profile.tier = 'verified' THEN 'professional'
    WHEN v_profile.tier IN ('starter', 'professional', 'elite') THEN v_profile.tier
    WHEN v_profile.previous_tier = 'verified' THEN 'professional'
    WHEN v_profile.previous_tier IN ('starter', 'professional', 'elite') THEN v_profile.previous_tier
    ELSE NULL
  END;

  UPDATE public.profiles
     SET status = 'suspended',
         tier = 'suspended',
         previous_tier = v_previous_tier,
         is_available = FALSE
   WHERE id = p_assembler_id;

  RETURN QUERY SELECT 'suspended'::TEXT, v_previous_tier, '[]'::JSONB;
END;
$$;

REVOKE ALL ON FUNCTION public.suspend_easer_if_no_active_jobs(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.suspend_easer_if_no_active_jobs(UUID, TEXT, TEXT)
  TO service_role;

-- Verification (read-only, run after applying):
-- SELECT id, email, account_closure_status, is_available
--   FROM public.profiles
--  WHERE account_closure_status IN ('requested','reviewing','completed')
--    AND is_available IS TRUE;
-- SELECT b.ref, p.email, p.account_closure_status
--   FROM public.bookings b JOIN public.profiles p ON p.id = b.assembler_id
--  WHERE b.status IN ('confirmed','en_route','arrived','in_progress')
--    AND p.account_closure_status IN ('requested','reviewing','completed');
-- SELECT id, booking_id, sender, recipient_type, read_at FROM public.messages
--  ORDER BY created_at DESC LIMIT 20;
-- SELECT ref, payout_status, payout_mode_snapshot FROM public.bookings
--  WHERE payout_status IN ('pending','paid','transferred') ORDER BY created_at DESC;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (37, 'owner_easer_workflow_completion')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
