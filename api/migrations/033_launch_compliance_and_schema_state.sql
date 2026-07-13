-- ============================================================
-- Migration 033: Launch compliance tracking and schema state
-- Apply after migration 032.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS w9_status TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS w9_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS w9_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS w9_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS w9_notes TEXT,
  ADD COLUMN IF NOT EXISTS account_closure_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_closure_status TEXT,
  ADD COLUMN IF NOT EXISTS account_closure_reason TEXT,
  ADD COLUMN IF NOT EXISTS auth_access_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auth_access_revoke_error TEXT;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_w9_status_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_w9_status_check
  CHECK (w9_status IN ('not_requested', 'requested', 'received', 'validated', 'not_required'));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_account_closure_status_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_account_closure_status_check
  CHECK (account_closure_status IS NULL OR account_closure_status IN ('requested', 'reviewing', 'cancelled', 'completed'));

-- Browser clients use authenticated APIs for bookings and evidence. Keeping
-- these base tables server-only prevents a permissive legacy policy or default
-- grant from exposing customer, payment, or assignment data through PostgREST.
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bookings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.bookings TO service_role;

ALTER TABLE public.booking_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "easer_insert_own_booking_evidence" ON public.booking_evidence;
DROP POLICY IF EXISTS "easer_select_own_evidence" ON public.booking_evidence;
REVOKE ALL ON TABLE public.booking_evidence FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_evidence TO service_role;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.easer_compliance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assembler_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  compliance_type TEXT NOT NULL CHECK (compliance_type IN ('w9')),
  status TEXT NOT NULL,
  notes TEXT,
  recorded_by TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_easer_compliance_events_assembler
  ON public.easer_compliance_events (assembler_id, created_at DESC);

ALTER TABLE public.easer_compliance_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.easer_compliance_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.easer_compliance_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_easer_w9_status(
  p_assembler_id UUID,
  p_status TEXT,
  p_notes TEXT DEFAULT NULL,
  p_recorded_by TEXT DEFAULT 'owner'
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_status NOT IN ('not_requested', 'requested', 'received', 'validated', 'not_required') THEN
    RAISE EXCEPTION 'Invalid W-9 status' USING ERRCODE = '22023';
  END IF;
  IF length(COALESCE(p_notes, '')) > 500 THEN
    RAISE EXCEPTION 'W-9 notes must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_notes, '') ~ '\m[0-9]{3}[- ]?[0-9]{2}[- ]?[0-9]{4}\M'
     OR COALESCE(p_notes, '') ~ '\m[0-9]{2}-?[0-9]{7}\M' THEN
    RAISE EXCEPTION 'Do not store SSNs, EINs, or raw W-9 contents in compliance notes' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
     SET w9_status = p_status,
         w9_notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
         w9_requested_at = CASE WHEN p_status = 'requested' THEN v_now ELSE w9_requested_at END,
         w9_received_at = CASE WHEN p_status IN ('received', 'validated') THEN v_now ELSE w9_received_at END,
         w9_validated_at = CASE WHEN p_status = 'validated' THEN v_now ELSE w9_validated_at END
   WHERE id = p_assembler_id
     AND role = 'assembler'
   RETURNING * INTO v_profile;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Easer not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.easer_compliance_events (
    assembler_id, compliance_type, status, notes, recorded_by
  ) VALUES (
    p_assembler_id, 'w9', p_status,
    NULLIF(btrim(COALESCE(p_notes, '')), ''),
    COALESCE(NULLIF(btrim(p_recorded_by), ''), 'owner')
  );

  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.record_easer_w9_status(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_easer_w9_status(UUID, TEXT, TEXT, TEXT) TO service_role;

CREATE TABLE IF NOT EXISTS public.platform_schema_state (
  migration_number INTEGER PRIMARY KEY,
  migration_name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.platform_schema_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_schema_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.platform_schema_state TO service_role;

-- Fail the migration if the launch-critical truth columns from migrations
-- 031-032 are not present in this database.
DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  IF to_regclass('public.activity_logs') IS NULL
     OR to_regclass('public.notification_log') IS NULL
     OR to_regclass('public.payout_ledger') IS NULL
     OR to_regclass('public.dispatch_offers') IS NULL
     OR to_regclass('public.booking_evidence') IS NULL
     OR to_regclass('public.booking_items') IS NULL
     OR to_regclass('public.financial_event_audit') IS NULL
     OR to_regclass('public.easer_compliance_events') IS NULL THEN
    RAISE EXCEPTION 'One or more launch-critical operational tables are missing';
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO v_missing
    FROM (VALUES
      ('bookings', 'guest_mutation_token_hash'),
      ('bookings', 'quote_approved_at'),
      ('bookings', 'refund_amount'),
      ('bookings', 'stripe_bank_payout_status'),
      ('bookings', 'stripe_fee'),
      ('bookings', 'service_call_fee'),
      ('bookings', 'tax_amount'),
      ('bookings', 'amount_charged'),
      ('bookings', 'assembler_due'),
      ('bookings', 'payout_status'),
      ('bookings', 'cancellation_easer_due_cents'),
      ('profiles', 'contractor_agreement_version'),
      ('profiles', 'w9_status')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = required.table_name
        AND c.column_name = required.column_name
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Launch-critical schema columns are missing: %', array_to_string(v_missing, ', ');
  END IF;
END;
$$;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (33, 'launch_compliance_and_schema_state')
ON CONFLICT (migration_number) DO UPDATE
  SET migration_name = EXCLUDED.migration_name,
      applied_at = NOW();
