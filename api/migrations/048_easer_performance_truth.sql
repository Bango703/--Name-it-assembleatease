-- Migration 048: keep Easer performance counters derived from booking truth.
--
-- profiles.completed_jobs and profiles.total_earned are display/ranking caches.
-- The prior increment-only RPC could drift after retries, reassignment, reopened
-- work, or owner-manual recovery. Recalculate them from bookings instead.

BEGIN;

-- Supabase SQL Editor sessions do not carry API JWT claims. Establish the
-- same transaction-local service-role context used by server-side writes so
-- the existing profile protection trigger can verify this migration backfill.
-- The setting disappears automatically at COMMIT/ROLLBACK.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

CREATE OR REPLACE FUNCTION public.sync_easer_performance_counters(
  p_easer_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_completed_jobs INTEGER := 0;
  v_total_earned INTEGER := 0;
BEGIN
  IF p_easer_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*) FILTER (
      WHERE booking.status = 'completed'
        AND COALESCE(booking.return_visit_required, FALSE) IS FALSE
    )::INTEGER,
    COALESCE(SUM(
      CASE
        WHEN booking.status = 'completed'
          AND COALESCE(booking.return_visit_required, FALSE) IS FALSE
          THEN GREATEST(COALESCE(booking.assembler_due, 0), 0)
        WHEN booking.status = 'cancelled'
          THEN GREATEST(COALESCE(booking.cancellation_easer_due_cents, 0), 0)
        ELSE 0
      END
    ), 0)::INTEGER
  INTO v_completed_jobs, v_total_earned
  FROM public.bookings booking
  WHERE booking.assembler_id = p_easer_id;

  UPDATE public.profiles profile
     SET completed_jobs = v_completed_jobs,
         total_earned = v_total_earned
   WHERE profile.id = p_easer_id
     AND profile.role = 'assembler'
     AND (
       profile.completed_jobs IS DISTINCT FROM v_completed_jobs
       OR profile.total_earned IS DISTINCT FROM v_total_earned
     );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_easer_performance_counters(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_easer_performance_counters(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_easer_performance_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.sync_easer_performance_counters(OLD.assembler_id);
    RETURN OLD;
  END IF;

  PERFORM public.sync_easer_performance_counters(NEW.assembler_id);

  IF TG_OP = 'UPDATE'
     AND OLD.assembler_id IS DISTINCT FROM NEW.assembler_id THEN
    PERFORM public.sync_easer_performance_counters(OLD.assembler_id);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_easer_performance_counters()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS bookings_refresh_easer_performance
  ON public.bookings;
CREATE TRIGGER bookings_refresh_easer_performance
  AFTER INSERT OR DELETE OR UPDATE OF status, assembler_id, assembler_due,
    cancellation_easer_due_cents, return_visit_required
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.refresh_easer_performance_counters();

-- Repair existing drift before the matching UI is deployed.
DO $backfill_easer_performance$
DECLARE
  v_easer RECORD;
BEGIN
  FOR v_easer IN
    SELECT id FROM public.profiles WHERE role = 'assembler'
  LOOP
    PERFORM public.sync_easer_performance_counters(v_easer.id);
  END LOOP;
END;
$backfill_easer_performance$;

-- The increment-only function is retained for migration compatibility but may
-- no longer be called by application code.
REVOKE ALL ON FUNCTION public.increment_profile_counters(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (48, 'easer_performance_truth')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
