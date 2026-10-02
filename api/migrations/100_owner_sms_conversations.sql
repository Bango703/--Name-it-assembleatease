-- ============================================================
-- Migration 100: Owner SMS conversations
--
-- Every SMS sent to the public number becomes a durable owner-visible
-- conversation, whether or not it matches a booking. Replies stay behind the
-- existing SMS consent gate in api/_sms.js; receiving a text never grants
-- permission to text that person back.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sms_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
  easer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'archived')),
  last_message_at TIMESTAMPTZ NOT NULL,
  last_message_preview TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sms_conversations IS
  'Owner inbox thread keyed by normalized sender phone. booking_id/easer_id are links, not identity proof.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_conversations_phone
  ON public.sms_conversations (phone);
CREATE INDEX IF NOT EXISTS idx_sms_conversations_activity
  ON public.sms_conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_conversations_booking
  ON public.sms_conversations (booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_conversations_easer
  ON public.sms_conversations (easer_id)
  WHERE easer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.sms_conversations(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender TEXT NOT NULL CHECK (sender IN ('customer', 'easer', 'owner', 'system')),
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  provider_id TEXT,
  notification_id UUID REFERENCES public.notification_log(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'queued', 'provider_accepted', 'sent', 'delivered', 'delivery_delayed', 'failed', 'suppressed')),
  error_text TEXT,
  read_at TIMESTAMPTZ,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sms_messages IS
  'Append-only owner SMS history. Provider delivery remains in notification_log; this table is the owner conversation view.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_provider
  ON public.sms_messages (provider_id)
  WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_messages_conversation_created
  ON public.sms_messages (conversation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_messages_unread_owner
  ON public.sms_messages (conversation_id)
  WHERE direction = 'inbound' AND read_at IS NULL;

ALTER TABLE public.sms_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='sms_conversations' AND policyname='service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON public.sms_conversations
      USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='sms_messages' AND policyname='service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON public.sms_messages
      USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.sms_conversations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sms_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sms_conversations TO service_role;
GRANT ALL ON TABLE public.sms_messages TO service_role;

DO $$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (100, '100_owner_sms_conversations')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
