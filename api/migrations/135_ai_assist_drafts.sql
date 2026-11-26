-- AI assist (owner, 2026-11-26): "can i implement ai to handle messaging and cases ?"
--
-- One row per suggestion the AI writes for the owner: a reply to a booking
-- message or an inbound text, or a summary and update for an operations case.
-- The message, text and case tables stay the source of truth for what was
-- said; this table records what the AI suggested and what became of it, so the
-- owner can judge the drafts before routine replies are allowed to send.
--
-- Written only by the service role (api/_ai-assist-runner.js). No customer or
-- Easer reads it.

CREATE TABLE IF NOT EXISTS public.ai_assist_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE CASCADE,
  source_message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  source_sms_id UUID REFERENCES public.sms_messages(id) ON DELETE CASCADE,
  sms_conversation_id UUID REFERENCES public.sms_conversations(id) ON DELETE CASCADE,
  case_id UUID REFERENCES public.operations_cases(id) ON DELETE CASCADE,
  source_created_at TIMESTAMPTZ,
  audience TEXT,
  category TEXT,
  routine BOOLEAN NOT NULL DEFAULT FALSE,
  urgent BOOLEAN NOT NULL DEFAULT FALSE,
  summary TEXT,
  next_step TEXT,
  draft_body TEXT,
  review_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 1,
  error_text TEXT,
  model TEXT,
  sent_message_id UUID,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_assist_drafts_kind_check CHECK (kind IN ('message', 'sms', 'case')),
  CONSTRAINT ai_assist_drafts_status_check CHECK (status IN (
    'pending', 'drafted', 'sent', 'edited_sent', 'auto_sent', 'dismissed', 'superseded', 'failed'
  )),
  CONSTRAINT ai_assist_drafts_audience_check CHECK (audience IS NULL OR audience IN ('customer', 'assembler', 'easer')),
  CONSTRAINT ai_assist_drafts_source_check CHECK (
    (kind = 'message' AND source_message_id IS NOT NULL AND booking_id IS NOT NULL)
    OR (kind = 'sms' AND source_sms_id IS NOT NULL AND sms_conversation_id IS NOT NULL)
    OR (kind = 'case' AND case_id IS NOT NULL)
  ),
  CONSTRAINT ai_assist_drafts_attempts_check CHECK (attempts BETWEEN 1 AND 10)
);

COMMENT ON TABLE public.ai_assist_drafts IS
  'AI-written suggestions for the owner (replies to booking messages and texts, case summaries). Never the record of what was said.';

-- One suggestion per inbound message or text; the cron and the dashboard can
-- both ask for one without writing two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_assist_drafts_message
  ON public.ai_assist_drafts (source_message_id)
  WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_assist_drafts_sms
  ON public.ai_assist_drafts (source_sms_id)
  WHERE source_sms_id IS NOT NULL;
-- One open suggestion per case; "New suggestion" retires the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_assist_drafts_case_open
  ON public.ai_assist_drafts (case_id)
  WHERE case_id IS NOT NULL AND status IN ('pending', 'drafted');

CREATE INDEX IF NOT EXISTS idx_ai_assist_drafts_booking
  ON public.ai_assist_drafts (booking_id, created_at DESC)
  WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_assist_drafts_status
  ON public.ai_assist_drafts (status, updated_at);

ALTER TABLE public.ai_assist_drafts ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
