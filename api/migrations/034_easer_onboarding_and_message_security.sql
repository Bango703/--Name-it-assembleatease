-- ============================================================
-- Migration 034: Easer onboarding, fee, and message security
--
-- P0 controls:
-- 1. Atomically allocate a finite founding-fee waiver under a DB lock.
-- 2. Block new unpaid/unwaived Easer profiles from entering ready states.
-- 3. Add an explicit expiry to Identity resume bearer tokens.
-- 4. Track and secure the messages table with assigned-Easer SELECT-only RLS.
--
-- Safe to re-run. Apply only after reviewing the verification queries below.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS application_fee_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS application_fee_waived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fee_waived_by_owner boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS application_fee_refunded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS application_fee_refund_id text,
  ADD COLUMN IF NOT EXISTS application_fee_refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS founding_easer boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS founding_easer_number integer,
  ADD COLUMN IF NOT EXISTS identity_resume_token_expires_at timestamptz;

-- Duplicate founding numbers indicate pre-existing financial truth that must be
-- reviewed rather than silently renumbered by a deployment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE founding_easer_number IS NOT NULL
     GROUP BY founding_easer_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate founding_easer_number values require owner review before migration 034';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_founding_easer_number_unique
  ON public.profiles(founding_easer_number)
  WHERE founding_easer_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_application_fee_refund_id_unique
  ON public.profiles(application_fee_refund_id)
  WHERE application_fee_refund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_identity_resume_token_expiry
  ON public.profiles(identity_resume_token_expires_at)
  WHERE identity_resume_token IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_founding_easer_waiver(
  p_profile_id uuid,
  p_limit integer
)
RETURNS TABLE(fee_waived boolean, founding_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_existing_waiver boolean;
  v_existing_number integer;
  v_slot integer;
BEGIN
  IF p_profile_id IS NULL OR p_limit IS NULL OR p_limit < 0 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Invalid founding waiver claim parameters' USING ERRCODE = '22023';
  END IF;

  -- One global transaction lock makes the finite first-N decision atomic even
  -- when multiple applications arrive together.
  PERFORM pg_advisory_xact_lock(hashtextextended('assembleatease_founding_easer_waiver', 0));

  SELECT role, application_fee_waived, founding_easer_number
    INTO v_role, v_existing_waiver, v_existing_number
    FROM public.profiles
   WHERE id = p_profile_id
   FOR UPDATE;

  IF NOT FOUND OR v_role IS DISTINCT FROM 'assembler' THEN
    RAISE EXCEPTION 'Easer profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_existing_waiver IS TRUE THEN
    fee_waived := true;
    founding_number := v_existing_number;
    RETURN NEXT;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM public.profiles WHERE application_fee_waived IS TRUE) < p_limit THEN
    SELECT candidate
      INTO v_slot
      FROM generate_series(1, p_limit) AS candidate
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.profiles p
        WHERE p.founding_easer_number = candidate
     )
     ORDER BY candidate
     LIMIT 1;
  END IF;

  fee_waived := v_slot IS NOT NULL;
  founding_number := v_slot;

  UPDATE public.profiles
     SET application_fee_waived = fee_waived,
         founding_easer = fee_waived,
         founding_easer_number = founding_number
   WHERE id = p_profile_id;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_founding_easer_waiver(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_founding_easer_waiver(uuid, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.guard_easer_fee_readiness_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entering_ready_state boolean := false;
  v_revoking_ready_fee boolean := false;
  v_fee_satisfied boolean;
BEGIN
  IF NEW.role IS DISTINCT FROM 'assembler' THEN
    RETURN NEW;
  END IF;

  v_fee_satisfied := NOT COALESCE(NEW.application_fee_refunded, false)
    AND (
      COALESCE(NEW.application_fee_paid, false)
      OR COALESCE(NEW.application_fee_waived, false)
      OR COALESCE(NEW.fee_waived_by_owner, false)
    );

  IF TG_OP = 'INSERT' THEN
    v_entering_ready_state := (
      NEW.status = 'active'
      OR NEW.application_status = 'approved'
      OR NEW.is_available IS TRUE
    );
  ELSE
    v_entering_ready_state := (
      (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
      OR (NEW.application_status = 'approved' AND OLD.application_status IS DISTINCT FROM 'approved')
      OR (NEW.is_available IS TRUE AND OLD.is_available IS NOT TRUE)
    );
    v_revoking_ready_fee := (
      (NEW.status = 'active' OR NEW.application_status = 'approved' OR NEW.is_available IS TRUE)
      AND (
        NOT COALESCE(OLD.application_fee_refunded, false)
        AND (
          COALESCE(OLD.application_fee_paid, false)
          OR COALESCE(OLD.application_fee_waived, false)
          OR COALESCE(OLD.fee_waived_by_owner, false)
        )
      )
      AND NOT v_fee_satisfied
    );
  END IF;

  IF (v_entering_ready_state AND NOT v_fee_satisfied) OR v_revoking_ready_fee THEN
    RAISE EXCEPTION 'Application fee must be paid or explicitly waived before Easer readiness'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_easer_fee_readiness ON public.profiles;
CREATE TRIGGER profiles_guard_easer_fee_readiness
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_easer_fee_readiness_transition();

REVOKE ALL ON FUNCTION public.guard_easer_fee_readiness_transition()
  FROM PUBLIC, anon, authenticated;

-- The table existed in early environments without a tracked migration. This
-- definition is additive for those environments and authoritative for new ones.
CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  sender text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_booking_created
  ON public.messages(booking_id, created_at);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Remove unknown historical browser policies so assignment ownership is the
-- only browser-visible truth. Service-role API routes continue to bypass RLS.
DO $$
DECLARE
  v_policy text;
BEGIN
  FOR v_policy IN
    SELECT policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'messages'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.messages', v_policy);
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;

-- Migration 033 intentionally removed browser SELECT rights from bookings and
-- profiles. A narrowly scoped SECURITY DEFINER predicate lets the messages RLS
-- policy verify assignment without restoring access to either private table.
CREATE OR REPLACE FUNCTION public.can_read_easer_booking_messages(p_booking_id uuid)
RETURNS boolean
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
       AND p.application_fee_refunded IS NOT TRUE
       AND (
         p.application_fee_paid IS TRUE
         OR p.application_fee_waived IS TRUE
         OR p.fee_waived_by_owner IS TRUE
       )
  );
$$;

REVOKE ALL ON FUNCTION public.can_read_easer_booking_messages(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_easer_booking_messages(uuid)
  TO authenticated;

CREATE POLICY messages_assigned_active_easer_select
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (public.can_read_easer_booking_messages(messages.booking_id));

-- Verification (read-only, run before/after applying):
-- SELECT founding_easer_number, count(*) FROM public.profiles
--  WHERE founding_easer_number IS NOT NULL
--  GROUP BY founding_easer_number HAVING count(*) > 1;
-- SELECT id, email, status, application_status, is_available
--   FROM public.profiles
--  WHERE role = 'assembler'
--    AND (status = 'active' OR application_status = 'approved' OR is_available IS TRUE)
--    AND (COALESCE(application_fee_refunded,false)
--      OR NOT (COALESCE(application_fee_paid,false)
--      OR COALESCE(application_fee_waived,false)
--      OR COALESCE(fee_waived_by_owner,false)));
-- SELECT id, email, application_fee_refunded, application_fee_refund_id
--   FROM public.profiles
--  WHERE application_fee_refunded IS DISTINCT FROM (application_fee_refund_id IS NOT NULL);
-- SELECT policyname, cmd, roles FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'messages';
