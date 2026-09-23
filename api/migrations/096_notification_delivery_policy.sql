-- Delivery intents and attempts stay in notification_log. Leases serialize
-- workflows only; they never assert that a person was notified.
BEGIN;
ALTER TABLE public.notification_log
  ADD COLUMN IF NOT EXISTS notification_key text,
  ADD COLUMN IF NOT EXISTS recipient_key text,
  ADD COLUMN IF NOT EXISTS dedupe_fingerprint text,
  ADD COLUMN IF NOT EXISTS routine boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS send_payload jsonb,
  ADD COLUMN IF NOT EXISTS booking_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS send_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS notification_log_send_key ON public.notification_log(notification_key) WHERE notification_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_log_recipient_cadence ON public.notification_log(recipient_key, sent_at DESC);
CREATE INDEX IF NOT EXISTS notification_log_pending_send ON public.notification_log(next_attempt_at) WHERE send_payload IS NOT NULL;
-- Payloads may contain signed management links. Only service-backed endpoints
-- with explicit response projections may read this operational ledger.
ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_log FROM anon, authenticated;
GRANT ALL ON public.notification_log TO service_role;
ALTER TABLE public.easer_announcement_deliveries ADD COLUMN IF NOT EXISTS reminder_state jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.notification_leases (
  lease_key text PRIMARY KEY,
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.notification_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_leases FROM anon, authenticated;
GRANT ALL ON public.notification_leases TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_notification_lease_v1(p_key text, p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token uuid;
BEGIN
  INSERT INTO notification_leases(lease_key, token, expires_at)
  VALUES(p_key,p_token,now()+interval '2 minutes')
  ON CONFLICT(lease_key) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
  WHERE notification_leases.expires_at < now()
  RETURNING token INTO v_token;
  RETURN v_token IS NOT NULL;
END $$;
CREATE OR REPLACE FUNCTION public.release_notification_lease_v1(p_key text, p_token uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM notification_leases WHERE lease_key=p_key AND token=p_token;
$$;

CREATE OR REPLACE FUNCTION public.reserve_notification_send_v1(
  p_key text, p_recipient_key text, p_fingerprint text, p_log jsonb,
  p_payload jsonb, p_snapshot jsonb, p_not_before timestamptz,
  p_expires_at timestamptz, p_routine boolean, p_dedupe_minutes integer,
  p_legacy_since timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row notification_log%ROWTYPE;
  v_prior notification_log%ROWTYPE;
  v_next timestamptz := greatest(now(),coalesce(p_not_before,now()));
  v_last timestamptz;
  v_count integer;
  v_token uuid;
BEGIN
  -- Includes both channels and different cron invocations for one recipient.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_recipient_key,0));
  SELECT * INTO v_row FROM notification_log WHERE notification_key=p_key FOR UPDATE;
  IF FOUND THEN
    IF v_row.status IN ('provider_accepted','sent','delivered','delivery_delayed') THEN
      RETURN jsonb_build_object('action','already_sent','id',v_row.id,'providerId',v_row.provider_id,'sentAt',coalesce(v_row.provider_accepted_at,v_row.sent_at));
    END IF;
    IF v_row.status IN ('uncertain','cancelled','bounced','complained') OR v_row.provider_id IS NOT NULL OR v_row.send_payload IS NULL THEN
      RETURN jsonb_build_object('action','blocked','id',v_row.id,'reason',coalesce(v_row.error_text,v_row.status));
    END IF;
    IF v_row.claim_expires_at > now() THEN
      RETURN jsonb_build_object('action','deferred','id',v_row.id,'reason','send_in_progress','nextAttemptAt',v_row.claim_expires_at);
    END IF;
    -- There is no proven SMS provider idempotency contract. A worker crash
    -- after beginning the request must not cause an unverified second text.
    IF v_row.status='queued' AND v_row.channel='sms' AND v_row.attempt_count>0 THEN
      UPDATE notification_log SET status='uncertain',error_text='SMS outcome unknown; review provider delivery before retrying',next_attempt_at=NULL,send_payload=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=v_row.id;
      RETURN jsonb_build_object('action','blocked','id',v_row.id,'reason','sms_delivery_unknown');
    END IF;
    IF v_row.send_expires_at <= now() OR v_row.attempt_count>=4
       OR (v_row.first_attempt_at IS NOT NULL AND v_row.first_attempt_at < now()-interval '23 hours') THEN
      UPDATE notification_log SET status='cancelled',error_text='Notification expired or retry limit reached; owner review required',next_attempt_at=NULL,send_payload=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=v_row.id;
      RETURN jsonb_build_object('action','blocked','id',v_row.id,'reason','expired_or_retry_limit');
    END IF;
    v_next := greatest(v_next,coalesce(v_row.next_attempt_at,now()));
  ELSE
    -- A legacy caller may cross its time bucket while an earlier attempt is
    -- pending. Let the retry worker finish that same frozen request/key.
    SELECT * INTO v_prior FROM notification_log n
      WHERE n.dedupe_fingerprint=p_fingerprint AND n.send_payload IS NOT NULL
        AND n.status IN ('queued','deferred','failed') AND n.send_expires_at>now()
      ORDER BY n.sent_at DESC LIMIT 1;
    IF FOUND AND p_dedupe_minutes>0 THEN
      RETURN jsonb_build_object('action','deferred','id',v_prior.id,'reason','prior_attempt_pending','nextAttemptAt',v_prior.next_attempt_at);
    END IF;
    -- Sliding-window compatibility for existing callers, plus migration-safe
    -- recognition of successful legacy reminders for the current appointment.
    SELECT * INTO v_prior FROM notification_log n
    WHERE n.channel=p_log->>'channel' AND n.recipient_email=p_log->>'recipient_email'
      AND n.notification_type=p_log->>'notification_type'
      AND n.status IN ('provider_accepted','sent','delivered','delivery_delayed')
      AND ((n.dedupe_fingerprint=p_fingerprint AND p_dedupe_minutes>0
        AND n.sent_at>=now()-make_interval(mins=>p_dedupe_minutes))
        OR (p_legacy_since IS NOT NULL AND n.notification_key IS NULL
          AND n.booking_id IS NOT DISTINCT FROM nullif(p_log->>'booking_id','')::uuid
          AND n.sent_at>=p_legacy_since))
    ORDER BY n.sent_at DESC LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('action','already_sent','id',v_prior.id,'providerId',v_prior.provider_id,'sentAt',coalesce(v_prior.provider_accepted_at,v_prior.sent_at)); END IF;
    INSERT INTO notification_log(notification_key,recipient_key,dedupe_fingerprint,channel,booking_id,operation_case_id,
      notification_type,recipient_type,recipient_email,recipient_user_id,subject,status,routine,send_payload,booking_snapshot,send_expires_at)
    VALUES(p_key,p_recipient_key,p_fingerprint,p_log->>'channel',nullif(p_log->>'booking_id','')::uuid,
      nullif(p_log->>'operation_case_id','')::uuid,p_log->>'notification_type',p_log->>'recipient_type',p_log->>'recipient_email',
      nullif(p_log->>'recipient_user_id','')::uuid,p_log->>'subject','deferred',p_routine,p_payload,p_snapshot,p_expires_at)
    RETURNING * INTO v_row;
  END IF;
  IF v_row.send_expires_at <= now() THEN
    UPDATE notification_log SET status='cancelled',error_text='Notification window expired',send_payload=NULL,next_attempt_at=NULL WHERE id=v_row.id;
    RETURN jsonb_build_object('action','blocked','id',v_row.id,'reason','notification_expired');
  END IF;
  IF p_routine THEN
    SELECT max(n.sent_at) INTO v_last FROM notification_log n
    WHERE n.id<>v_row.id AND n.status IN ('provider_accepted','sent','delivered','delivery_delayed','queued','uncertain')
      AND (n.recipient_key=p_recipient_key OR (n.recipient_key IS NULL AND n.recipient_type=v_row.recipient_type AND
        (n.recipient_user_id IS NOT NULL AND n.recipient_user_id=v_row.recipient_user_id
          OR n.recipient_email=v_row.recipient_email
          OR n.booking_id=v_row.booking_id AND n.recipient_type=v_row.recipient_type)))
      AND n.sent_at>now()-interval '4 hours';
    IF v_last IS NOT NULL THEN v_next:=greatest(v_next,v_last+interval '4 hours'); END IF;
    SELECT count(*),min(n.sent_at) INTO v_count,v_last FROM notification_log n
    WHERE n.id<>v_row.id
      AND (n.recipient_key=p_recipient_key OR (n.recipient_key IS NULL AND n.recipient_type=v_row.recipient_type AND
        (n.recipient_user_id IS NOT NULL AND n.recipient_user_id=v_row.recipient_user_id
          OR n.recipient_email=v_row.recipient_email
          OR n.booking_id=v_row.booking_id AND n.recipient_type=v_row.recipient_type)))
      AND (n.routine OR (n.notification_key IS NULL AND
        (n.notification_type IN ('reminder','easer_reminder','appointment_day_of','review_request','followup','easer_coaching','broadcast')
         OR n.notification_type ~ '^(review_request_[0-9]+|easer_tier_.*|easer_required_action_.*)$')))
      AND n.status IN ('provider_accepted','sent','delivered','delivery_delayed','queued','uncertain')
      AND n.sent_at>now()-interval '24 hours';
    IF v_count>=2 THEN v_next:=greatest(v_next,v_last+interval '24 hours'); END IF;
  END IF;
  IF v_next>now() THEN
    UPDATE notification_log SET status='deferred',next_attempt_at=v_next,error_text='Waiting for notification timing policy',claim_token=NULL,claim_expires_at=NULL WHERE id=v_row.id;
    RETURN jsonb_build_object('action','deferred','id',v_row.id,'reason','timing_policy','nextAttemptAt',v_next);
  END IF;
  v_token:=gen_random_uuid();
  UPDATE notification_log SET status='queued',claim_token=v_token,claim_expires_at=now()+interval '2 minutes',
    next_attempt_at=now()+interval '2 minutes',attempt_count=attempt_count+1,
    first_attempt_at=coalesce(first_attempt_at,now()),sent_at=now(),error_text=NULL
  WHERE id=v_row.id RETURNING * INTO v_row;
  RETURN jsonb_build_object('action','send','id',v_row.id,'token',v_token,'attempt',v_row.attempt_count,'payload',v_row.send_payload,'snapshot',v_row.booking_snapshot,'key',v_row.notification_key);
END $$;

REVOKE ALL ON FUNCTION public.acquire_notification_lease_v1(text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.release_notification_lease_v1(text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reserve_notification_send_v1(text,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz,boolean,integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_notification_lease_v1(text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_notification_lease_v1(text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_notification_send_v1(text,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz,boolean,integer,timestamptz) TO service_role;
-- Per-run submission summaries; actual later delivery remains notification_log.
ALTER TABLE public.email_broadcasts
  ADD COLUMN IF NOT EXISTS deferred_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS already_sent_count integer NOT NULL DEFAULT 0;
INSERT INTO public.platform_schema_state(migration_number,migration_name)
VALUES(96,'notification_delivery_policy') ON CONFLICT(migration_number) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
