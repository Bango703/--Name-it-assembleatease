-- ============================================================
-- Migration 087: messages.updated_at — the column a trigger already expects
--
-- THE BUG
-- Marking a customer message as read failed every single time with:
--
--   record "new" has no field "updated_at"
--
-- A BEFORE UPDATE trigger on public.messages assigns NEW.updated_at, but the
-- table has no such column. Postgres raises before the row is written, so the
-- UPDATE is rejected. Reproduced on a live row on 2026-08-29.
--
-- WHY IT LOOKED LIKE A COSMETIC ANNOYANCE
-- api/booking/message.js treats the read-state write as non-fatal on purpose —
-- seeing a thread must never depend on it. So the thread loaded, the toast
-- appeared, and the owner was told "Could not mark 1 message as read" over and
-- over. The unread badge could never clear, because the write behind it never
-- succeeded once.
--
-- WHY NO MIGRATION CREATED THAT TRIGGER
-- None did. It was added by hand in Supabase, which Article 7 exists to
-- prevent: a trigger that lives only in the database is invisible to review, to
-- tests, and to every guard in this repo. It sat broken indefinitely because
-- nothing in version control knew it existed.
--
-- THE FIX, AND WHY THIS ONE
-- Add the column rather than drop the trigger. Dropping removes behaviour
-- somebody deliberately added, for reasons not recorded anywhere; adding
-- satisfies it and leaves an audit field that a messages table should arguably
-- have had from the start. If the trigger later proves unwanted it can be
-- dropped on its own, with this column doing no harm.
--
-- Existing rows are backfilled from created_at, which is true: nothing has ever
-- been updated, because every update has failed.
-- ============================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Never been updated, so the only honest value is when it was written.
UPDATE public.messages
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE public.messages
  ALTER COLUMN updated_at SET DEFAULT NOW();

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (87, '087_messages_updated_at')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'messages' AND column_name = 'updated_at';
-- Expected: one row, timestamp with time zone, default now().

-- Which trigger was assigning it. Worth knowing, since it exists nowhere in
-- this repo — copy the result into a migration so the next person can see it.
SELECT t.tgname AS trigger_name,
       p.proname AS function_name,
       pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
 WHERE c.relname = 'messages'
   AND NOT t.tgisinternal;

-- Proof the write now succeeds. Touches one row and changes nothing about it.
UPDATE public.messages SET read_at = read_at
 WHERE id = (SELECT id FROM public.messages ORDER BY created_at LIMIT 1);
-- Expected: UPDATE 1, with no error.
