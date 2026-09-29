-- Migration 101: preserve crew access and earnings during lead handoffs.
--
-- A lead assignment is stored in bookings.assembler_id. Existing crew rows
-- carry per-person pay obligations. Replacing the lead cannot silently rewrite
-- or orphan those obligations. Until an explicit transactional crew handoff is
-- implemented, any active crew allocation blocks a change of lead (including
-- release). Ordinary assignments with no active crew continue unchanged.
--
-- add_booking_crew_member/remove_booking_crew_member lock the booking before
-- changing crew. This trigger runs while that same booking row is locked, so a
-- concurrent crew add cannot slip between the API preflight and assignment CAS.
-- This migration does not update booking, crew, payout, or ledger records.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.booking_crew') IS NULL THEN
    RAISE EXCEPTION 'Apply migration 077 before migration 101';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_crew_assignment_handoff()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.assembler_id IS DISTINCT FROM NEW.assembler_id
     AND EXISTS (
       SELECT 1 FROM public.booking_crew
        WHERE booking_id = OLD.id AND removed_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Active crew allocations require review before changing the lead Easer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_crew_assignment_handoff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_crew_assignment_handoff() TO service_role;

DROP TRIGGER IF EXISTS trg_guard_crew_assignment_handoff ON public.bookings;
CREATE TRIGGER trg_guard_crew_assignment_handoff
  BEFORE UPDATE OF assembler_id ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.guard_crew_assignment_handoff();

DO $$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (101, '101_guard_crew_assignment_handoff')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$$;

COMMIT;
