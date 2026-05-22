-- ============================================================
-- Migration 006: active_jobs_today increment/decrement RPCs
-- Run in Supabase SQL Editor (safe to re-run: CREATE OR REPLACE)
-- ============================================================

-- Increment active_jobs_today — used on Easer assignment/acceptance
CREATE OR REPLACE FUNCTION increment_active_jobs(user_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE profiles
  SET active_jobs_today = COALESCE(active_jobs_today, 0) + 1
  WHERE id = user_id;
$$;

-- Decrement active_jobs_today — floors at 0, never goes negative
-- Used on cancellation, reassignment away, and job completion.
CREATE OR REPLACE FUNCTION decrement_active_jobs(user_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE profiles
  SET active_jobs_today = GREATEST(0, COALESCE(active_jobs_today, 0) - 1)
  WHERE id = user_id;
$$;

GRANT EXECUTE ON FUNCTION increment_active_jobs(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION decrement_active_jobs(UUID) TO service_role;

-- ── Verification ─────────────────────────────────────────────
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public'
--   AND routine_name IN ('increment_active_jobs', 'decrement_active_jobs')
--   ORDER BY routine_name;
-- Expected: 2 rows
