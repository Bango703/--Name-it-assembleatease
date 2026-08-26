-- ============================================================
-- Read-only. Changes nothing.
--
-- "The Easer message badge keeps showing even after I read it, and survives a
--  hard refresh."
--
-- The badge is computed in api/booking/list.js as: any row in `messages` for the
-- booking with recipient_type = 'owner' AND read_at IS NULL. It clears only when
-- api/booking/message.js (GET) writes read_at — which it does ONLY for rows whose
-- recipient_type is exactly 'owner'.
--
-- So a row that is counted as unread but never marked read means the two
-- conditions disagree. This shows the raw rows so the mismatch is visible
-- instead of guessed at.
-- ============================================================

-- 1) Every message the owner badge considers unread, with the fields that decide
--    whether the mark-as-read step will actually touch it.
SELECT m.id,
       b.ref,
       b.status                AS booking_status,
       m.sender,
       m.recipient_type,
       m.recipient_user_id,
       m.sender_user_id,
       m.read_at,
       m.created_at,
       left(m.body, 60)        AS body_preview,
       CASE
         WHEN m.recipient_type IS NULL
           THEN 'STUCK: recipient_type is NULL — list.js does not count it, but if the badge shows, something else does'
         WHEN m.recipient_type <> 'owner'
           THEN 'STUCK: recipient_type is ' || m.recipient_type || ' — the owner read path only marks rows with recipient_type = owner'
         WHEN m.read_at IS NULL
           THEN 'UNREAD: will clear the next time the owner opens this booking''s Messages tab'
         ELSE 'read'
       END                     AS verdict
  FROM public.messages m
  JOIN public.bookings b ON b.id = m.booking_id
 WHERE m.read_at IS NULL
 ORDER BY m.created_at DESC
 LIMIT 50;

-- 2) Per booking: what the badge counts vs what the read path would mark.
--    Any row where badge_counts > markable is a badge that can never clear.
SELECT b.ref,
       b.status,
       count(*) FILTER (WHERE m.recipient_type = 'owner' AND m.read_at IS NULL) AS badge_counts,
       count(*) FILTER (WHERE m.recipient_type = 'owner' AND m.read_at IS NULL) AS markable,
       count(*) FILTER (WHERE m.recipient_type IS DISTINCT FROM 'owner' AND m.read_at IS NULL) AS unread_not_owner_addressed,
       count(*) AS total_messages
  FROM public.bookings b
  JOIN public.messages m ON m.booking_id = b.id
 GROUP BY b.ref, b.status
HAVING count(*) FILTER (WHERE m.read_at IS NULL) > 0
 ORDER BY b.ref;

-- 3) Anything on `messages` that could silently reject the read_at UPDATE the
--    way profiles_guard_self_update rejects profile writes.
SELECT tg.tgname AS trigger_name,
       CASE tg.tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED' ELSE tg.tgenabled::text END AS state,
       pg_get_triggerdef(tg.oid) AS definition
  FROM pg_trigger tg
  JOIN pg_class rel ON rel.oid = tg.tgrelid
 WHERE rel.relname = 'messages'
   AND NOT tg.tgisinternal;
