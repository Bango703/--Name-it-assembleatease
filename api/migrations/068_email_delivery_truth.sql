-- ============================================================
-- Migration 068: Provider-authoritative email delivery truth
-- Apply after migration 067.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.notification_log') IS NULL
     OR to_regclass('public.platform_schema_state') IS NULL THEN
    RAISE EXCEPTION 'Apply launch migrations through 067 before migration 068';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_schema_state WHERE migration_number = 67
  ) THEN
    RAISE EXCEPTION 'Apply migration 067 before migration 068';
  END IF;
END $$;

ALTER TABLE public.notification_log
  ADD COLUMN IF NOT EXISTS provider_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_delayed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_provider_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_provider_event_type TEXT,
  ADD COLUMN IF NOT EXISTS provider_event_payload JSONB,
  ADD COLUMN IF NOT EXISTS recipient_read_at TIMESTAMPTZ;

-- Historical "sent" rows only prove that the provider accepted the API
-- request. Do not rewrite push rows, whose status has different semantics.
UPDATE public.notification_log
   SET status = 'provider_accepted',
       provider_accepted_at = COALESCE(provider_accepted_at, sent_at)
 WHERE channel = 'email'
   AND status = 'sent'
   AND provider_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_provider_id
  ON public.notification_log (provider_id)
  WHERE channel = 'email' AND provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_log_delivery_attention
  ON public.notification_log (status, sent_at DESC)
  WHERE channel = 'email'
    AND status IN ('failed', 'bounced', 'complained', 'delivery_delayed');

CREATE INDEX IF NOT EXISTS idx_notification_log_easer_inbox
  ON public.notification_log (recipient_user_id, sent_at DESC)
  WHERE recipient_type = 'easer';

CREATE TABLE IF NOT EXISTS public.email_provider_events (
  svix_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_created_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_provider_events_provider
  ON public.email_provider_events (provider_id, event_created_at DESC);

ALTER TABLE public.email_provider_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'email_provider_events'
       AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.email_provider_events
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.apply_resend_delivery_event_v1(
  p_svix_id TEXT,
  p_provider_id TEXT,
  p_event_type TEXT,
  p_event_created_at TIMESTAMPTZ,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  event_recorded BOOLEAN,
  notification_found BOOLEAN,
  notification_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER := 0;
  v_log public.notification_log%ROWTYPE;
  v_status TEXT;
  v_error TEXT;
BEGIN
  IF COALESCE(BTRIM(p_svix_id), '') = ''
     OR COALESCE(BTRIM(p_provider_id), '') = ''
     OR COALESCE(BTRIM(p_event_type), '') = ''
     OR p_event_created_at IS NULL THEN
    RAISE EXCEPTION 'Complete provider event identity is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.email_provider_events (
    svix_id, provider_id, event_type, event_created_at, payload
  ) VALUES (
    BTRIM(p_svix_id), BTRIM(p_provider_id), LOWER(BTRIM(p_event_type)),
    p_event_created_at, COALESCE(p_payload, '{}'::jsonb)
  ) ON CONFLICT (svix_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT *
    INTO v_log
    FROM public.notification_log
   WHERE provider_id = BTRIM(p_provider_id)
     AND channel = 'email'
   ORDER BY sent_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT v_inserted = 1, FALSE, NULL::TEXT;
    RETURN;
  END IF;

  -- Resend retries events and does not guarantee delivery order. The provider
  -- event timestamp, not arrival order, controls the current state.
  IF v_log.last_provider_event_at IS NOT NULL
     AND p_event_created_at < v_log.last_provider_event_at THEN
    RETURN QUERY SELECT v_inserted = 1, TRUE, v_log.status;
    RETURN;
  END IF;

  v_status := CASE LOWER(BTRIM(p_event_type))
    WHEN 'email.sent' THEN 'sent'
    WHEN 'email.delivered' THEN 'delivered'
    WHEN 'email.delivery_delayed' THEN 'delivery_delayed'
    WHEN 'email.bounced' THEN 'bounced'
    WHEN 'email.complained' THEN 'complained'
    WHEN 'email.failed' THEN 'failed'
    WHEN 'email.suppressed' THEN 'suppressed'
    ELSE NULL
  END;

  IF v_status IS NULL THEN
    RETURN QUERY SELECT v_inserted = 1, TRUE, v_log.status;
    RETURN;
  END IF;

  v_error := COALESCE(
    p_payload #>> '{data,bounce,message}',
    p_payload #>> '{data,error,message}',
    p_payload #>> '{data,error}',
    p_payload #>> '{data,reason}'
  );

  UPDATE public.notification_log
     SET status = v_status,
         provider_accepted_at = COALESCE(provider_accepted_at, sent_at),
         provider_sent_at = CASE WHEN v_status = 'sent'
           THEN COALESCE(provider_sent_at, p_event_created_at) ELSE provider_sent_at END,
         delivered_at = CASE WHEN v_status = 'delivered'
           THEN COALESCE(delivered_at, p_event_created_at) ELSE delivered_at END,
         delivery_delayed_at = CASE WHEN v_status = 'delivery_delayed'
           THEN COALESCE(delivery_delayed_at, p_event_created_at) ELSE delivery_delayed_at END,
         bounced_at = CASE WHEN v_status = 'bounced'
           THEN COALESCE(bounced_at, p_event_created_at) ELSE bounced_at END,
         complained_at = CASE WHEN v_status = 'complained'
           THEN COALESCE(complained_at, p_event_created_at) ELSE complained_at END,
         provider_failed_at = CASE WHEN v_status = 'failed'
           THEN COALESCE(provider_failed_at, p_event_created_at) ELSE provider_failed_at END,
         last_provider_event_at = p_event_created_at,
         last_provider_event_type = LOWER(BTRIM(p_event_type)),
         provider_event_payload = COALESCE(p_payload, '{}'::jsonb),
         error_text = CASE
           WHEN v_status IN ('failed', 'bounced', 'complained', 'delivery_delayed', 'suppressed')
             THEN COALESCE(NULLIF(v_error, ''), error_text, v_status)
           ELSE error_text
         END
   WHERE id = v_log.id;

  RETURN QUERY SELECT v_inserted = 1, TRUE, v_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_resend_delivery_events_v1(
  p_provider_id TEXT
)
RETURNS TABLE (
  notification_found BOOLEAN,
  notification_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event public.email_provider_events%ROWTYPE;
  v_result RECORD;
BEGIN
  SELECT *
    INTO v_event
    FROM public.email_provider_events
   WHERE provider_id = BTRIM(p_provider_id)
     AND event_type IN (
       'email.sent', 'email.delivered', 'email.delivery_delayed',
       'email.bounced', 'email.complained', 'email.failed', 'email.suppressed'
     )
   ORDER BY event_created_at DESC, received_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT EXISTS (
      SELECT 1 FROM public.notification_log
       WHERE provider_id = BTRIM(p_provider_id) AND channel = 'email'
    ), NULL::TEXT;
    RETURN;
  END IF;

  SELECT *
    INTO v_result
    FROM public.apply_resend_delivery_event_v1(
      v_event.svix_id,
      v_event.provider_id,
      v_event.event_type,
      v_event.event_created_at,
      v_event.payload
    );

  RETURN QUERY SELECT COALESCE(v_result.notification_found, FALSE), v_result.notification_status;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_resend_delivery_event_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_resend_delivery_events_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_resend_delivery_event_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_resend_delivery_events_v1(TEXT) TO service_role;
GRANT ALL ON TABLE public.email_provider_events TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (68, 'email_delivery_truth')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
