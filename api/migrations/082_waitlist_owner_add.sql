-- ============================================================
-- Migration 082: owner-added waitlist entries + usable location
--
-- WHAT THIS FIXES
-- The waitlist could only be joined from the public form. When the owner met a
-- promising person on a job site, at a store, or through a referral, there was
-- nowhere to put them — so they lived in a phone's notes app, which is to say
-- they were lost. Supply is half of a two-sided marketplace and it was the half
-- with no inbox.
--
-- TWO COLUMNS, EACH EARNING ITS PLACE:
--
--   zip     The waitlist stored city + state only. Neither answers the question
--           that actually decides anything — can we dispatch to this person?
--           That test is isAutomaticDispatchZip(), and it needs five digits.
--           "Austin, TX" is a place; "78704" is a yes or a no. Nullable, because
--           the owner learns someone's name and city long before their ZIP, and
--           refusing the row until he has it loses the lead.
--
--   source  Where the row came from. This is not bookkeeping. "Eleven people are
--           waiting in Dallas" means a market is pulling at us; "eleven people
--           the owner typed in himself" means the owner has been busy. Those are
--           opposite facts and without this column they are the same table.
--           Demand signal and a to-do list must never be indistinguishable.
--
-- Existing rows are all public signups by definition — the owner had no way to
-- create one until now — so the DEFAULT backfills them correctly and honestly.
-- ============================================================

ALTER TABLE public.assembler_waitlist
  ADD COLUMN IF NOT EXISTS zip TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'public_form';

-- Five digits or nothing. A half-typed ZIP is worse than a blank one: it would
-- silently fail the dispatch-area test and read as "we cannot serve them".
ALTER TABLE public.assembler_waitlist
  DROP CONSTRAINT IF EXISTS assembler_waitlist_zip_format_check;
ALTER TABLE public.assembler_waitlist
  ADD CONSTRAINT assembler_waitlist_zip_format_check
  CHECK (zip IS NULL OR zip ~ '^[0-9]{5}$');

ALTER TABLE public.assembler_waitlist
  DROP CONSTRAINT IF EXISTS assembler_waitlist_source_check;
ALTER TABLE public.assembler_waitlist
  ADD CONSTRAINT assembler_waitlist_source_check
  CHECK (source IN ('public_form', 'owner_added'));

-- "Where is my supply concentrated, and is any of it real?" — the two questions
-- the waitlist exists to answer, so they get the index.
CREATE INDEX IF NOT EXISTS idx_waitlist_market
  ON public.assembler_waitlist (state, city);
CREATE INDEX IF NOT EXISTS idx_waitlist_source_status
  ON public.assembler_waitlist (source, status);

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (82, '082_waitlist_owner_add')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'assembler_waitlist'
   AND column_name IN ('zip', 'source')
 ORDER BY 1;
-- Expected: zip (YES, null) and source (NO, 'public_form'::text).

SELECT source, COUNT(*) FROM public.assembler_waitlist GROUP BY source;
-- Expected: every existing row reads public_form.
