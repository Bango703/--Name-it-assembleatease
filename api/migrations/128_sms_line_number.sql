-- ============================================================
-- Migration 128: which AssembleAtEase number each text used
--
-- Owner, 2026-11-09: three numbers, three jobs. The business number is for
-- people reaching AssembleAtEase; automatic updates come from the text number.
-- A reply in the owner's Messages view goes back from the number the person
-- texted, so it lands in the same thread on their phone.
--
--   line_number  the AssembleAtEase number a text came in on or went out
--                from, in +1XXXXXXXXXX form. NULL for texts saved before this
--                migration; a reply to those comes from the business number.
--
-- The code saves messages without it until this runs (api/_sms-conversations.js).
-- ============================================================

BEGIN;

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS line_number TEXT;

CREATE INDEX IF NOT EXISTS idx_sms_messages_conversation_line
  ON public.sms_messages (conversation_id, occurred_at DESC)
  WHERE direction = 'inbound' AND line_number IS NOT NULL;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (128, 'sms_line_number')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
