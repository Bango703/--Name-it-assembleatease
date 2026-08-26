-- ============================================================
-- Read-only. Changes nothing. Run this FIRST in the Supabase SQL editor and
-- paste the output back — it confirms the blocked Easer application in seconds.
-- ============================================================

-- 1) Every CHECK constraint on profiles that mentions application_status,
--    with its exact definition. This is the one rejecting the insert.
SELECT con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
 WHERE nsp.nspname = 'public'
   AND rel.relname = 'profiles'
   AND con.contype = 'c'
   AND pg_get_constraintdef(con.oid) ILIKE '%application_status%';

-- 2) What values actually exist today, so nothing legitimate gets locked out.
SELECT COALESCE(application_status, '(null / customer row)') AS application_status,
       count(*) AS rows
  FROM public.profiles
 GROUP BY 1
 ORDER BY rows DESC;

-- 3) Direct answer to "would a new applicant be rejected right now?"
--    Expect FALSE if the constraint is stale — that FALSE is the bug.
SELECT 'payment_pending' AS value_apply_js_inserts,
       'payment_pending' IN ('payment_pending', 'applied', 'approved', 'rejected')
         AS allowed_by_intended_constraint;

-- 4) The legacy 'waitlist' rows, so you can see who they are. These predate the
--    current design (the live waitlist is now the assembler_waitlist table) and
--    no code path reads this value. Migration 069 preserves them untouched.
--    They may be real would-be Easers worth inviting to apply properly.
SELECT id, full_name, email, city, state, created_at
  FROM public.profiles
 WHERE application_status = 'waitlist'
 ORDER BY created_at DESC;
