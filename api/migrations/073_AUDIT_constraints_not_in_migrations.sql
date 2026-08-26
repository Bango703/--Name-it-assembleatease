-- ============================================================
-- Read-only. Changes nothing. Run whenever schema truth is in question.
--
-- WHY THIS EXISTS: the CHECK constraint that broke Easer applications lived ONLY
-- in the live database. No migration in this repo declared it, so no code review,
-- no test, and no drift guard could see it — it stayed invisible for months and
-- surfaced as an outage the first time a real person applied.
--
-- scripts/check-status-constraint-drift.mjs compares code against constraints
-- declared in api/migrations/. It is blind to anything added by hand in the
-- Supabase console. This query lists what the DATABASE actually enforces, so it
-- can be diffed against the migrations folder and any gap written down.
--
-- WORKFLOW: run this, compare the output to api/migrations/*.sql, and for every
-- constraint that has no migration, add one (a plain
-- `ALTER TABLE ... DROP CONSTRAINT IF EXISTS x; ALTER TABLE ... ADD CONSTRAINT x CHECK (...)`
-- reproducing its definition verbatim is enough). After that the drift guard
-- covers it.
-- ============================================================

-- 1) Every CHECK constraint on the application's own tables, with its exact
--    definition. This is the authoritative list to reconcile against.
SELECT rel.relname                        AS table_name,
       con.conname                        AS constraint_name,
       pg_get_constraintdef(con.oid)      AS definition
  FROM pg_constraint con
  JOIN pg_class rel      ON rel.oid = con.conrelid
  JOIN pg_namespace nsp  ON nsp.oid = rel.relnamespace
 WHERE nsp.nspname = 'public'
   AND con.contype = 'c'
   AND rel.relname IN (
     'profiles', 'bookings', 'dispatch_offers', 'payout_ledger',
     'financial_event_audit', 'notification_log', 'operational_events',
     'booking_messages', 'booking_notes', 'booking_timeline',
     'easer_announcements', 'easer_announcement_deliveries',
     'operations_cases', 'customer_memberships', 'assembler_waitlist'
   )
 ORDER BY rel.relname, con.conname;

-- 2) Triggers on the same tables. profiles_guard_self_update is the reason a
--    plain UPDATE from the SQL editor is rejected; anything unexpected here
--    changes write behaviour in ways the code does not describe.
SELECT rel.relname   AS table_name,
       tg.tgname     AS trigger_name,
       CASE tg.tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED — INVESTIGATE' ELSE tg.tgenabled::text END AS state,
       pg_get_triggerdef(tg.oid) AS definition
  FROM pg_trigger tg
  JOIN pg_class rel     ON rel.oid = tg.tgrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
 WHERE nsp.nspname = 'public'
   AND NOT tg.tgisinternal
   AND rel.relname IN ('profiles', 'bookings', 'payout_ledger', 'dispatch_offers')
 ORDER BY rel.relname, tg.tgname;

-- 3) Columns that are NOT NULL with no default. A code path that omits one of
--    these fails at insert time — the same shape as the add-easer.js bug, where
--    an omitted column silently produced a NULL status that hid an Easer from
--    every .eq('status', ...) query.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('profiles', 'bookings')
   AND is_nullable = 'NO'
   AND column_default IS NULL
 ORDER BY table_name, column_name;
