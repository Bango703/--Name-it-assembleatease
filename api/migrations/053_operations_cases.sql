-- AssembleAtEase migration 053
-- Durable owner operations cases for support, quality, safety, payment,
-- dispute, and damage coordination.
--
-- This case layer never mutates booking, Stripe, refund, payout, dispatch, or
-- damage-hold truth. Those domains remain authoritative in their existing
-- tables and verified workflows.
-- Apply AFTER migration 052. Safe to re-run.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.bookings') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.notification_log') IS NULL
     OR to_regclass('public.platform_schema_state') IS NULL THEN
    RAISE EXCEPTION 'Apply launch migrations through 052 before migration 053';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_schema_state schema_state
     WHERE schema_state.migration_number = 52
  ) THEN
    RAISE EXCEPTION 'Migration 052 must be recorded before migration 053';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.operations_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref TEXT NOT NULL UNIQUE,
  case_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'normal',
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  easer_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_to TEXT NOT NULL DEFAULT 'owner',
  acknowledged_at TIMESTAMPTZ,
  last_public_update_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  resolution_summary TEXT,
  created_by_type TEXT NOT NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operations_cases_ref_format CHECK (
    case_ref ~ '^[A-Z0-9-]{8,48}$'
  ),
  CONSTRAINT operations_cases_type_check CHECK (
    case_type IN (
      'support', 'damage', 'quality', 'payment', 'dispute', 'safety',
      'late_arrival', 'no_show', 'missing_hardware', 'account'
    )
  ),
  CONSTRAINT operations_cases_source_check CHECK (
    source IN (
      'contact_form', 'booking', 'customer_report', 'easer_report',
      'stripe', 'owner', 'system'
    )
  ),
  CONSTRAINT operations_cases_status_check CHECK (
    status IN (
      'open', 'acknowledged', 'in_progress', 'waiting_customer',
      'waiting_easer', 'resolved', 'closed'
    )
  ),
  CONSTRAINT operations_cases_severity_check CHECK (
    severity IN ('low', 'normal', 'high', 'critical')
  ),
  CONSTRAINT operations_cases_actor_check CHECK (
    created_by_type IN ('owner', 'customer', 'easer', 'system', 'stripe')
  ),
  CONSTRAINT operations_cases_subject_length CHECK (
    char_length(btrim(subject)) BETWEEN 1 AND 180
  ),
  CONSTRAINT operations_cases_description_length CHECK (
    char_length(btrim(description)) BETWEEN 1 AND 5000
  ),
  CONSTRAINT operations_cases_resolution_shape CHECK (
    (status NOT IN ('resolved', 'closed'))
    OR (resolved_at IS NOT NULL AND char_length(btrim(COALESCE(resolution_summary, ''))) >= 10)
  )
);

ALTER TABLE public.operations_cases
  ADD COLUMN IF NOT EXISTS last_public_update_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operations_cases_source_ref
  ON public.operations_cases (source, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_cases_status_updated
  ON public.operations_cases (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_cases_type_created
  ON public.operations_cases (case_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_cases_booking
  ON public.operations_cases (booking_id, created_at DESC)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_cases_customer_email
  ON public.operations_cases (lower(customer_email), created_at DESC)
  WHERE customer_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.operations_case_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES public.operations_cases(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  actor_name TEXT,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  public_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operations_case_events_type_check CHECK (
    event_type IN (
      'created', 'status_changed', 'internal_note',
      'notification_attempted', 'public_update', 'linkage_updated'
    )
  ),
  CONSTRAINT operations_case_events_actor_check CHECK (
    actor_type IN ('owner', 'customer', 'easer', 'system', 'stripe')
  ),
  CONSTRAINT operations_case_events_status_check CHECK (
    (from_status IS NULL OR from_status IN (
      'open', 'acknowledged', 'in_progress', 'waiting_customer',
      'waiting_easer', 'resolved', 'closed'
    ))
    AND
    (to_status IS NULL OR to_status IN (
      'open', 'acknowledged', 'in_progress', 'waiting_customer',
      'waiting_easer', 'resolved', 'closed'
    ))
  ),
  CONSTRAINT operations_case_events_note_length CHECK (
    note IS NULL OR char_length(note) <= 4000
  ),
  CONSTRAINT operations_case_events_public_length CHECK (
    public_message IS NULL OR char_length(public_message) <= 2000
  )
);

CREATE INDEX IF NOT EXISTS idx_operations_case_events_case_created
  ON public.operations_case_events (case_id, created_at ASC);

ALTER TABLE public.operations_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operations_case_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.operations_cases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.operations_case_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.operations_cases TO service_role;
GRANT ALL ON TABLE public.operations_case_events TO service_role;

ALTER TABLE public.notification_log
  ADD COLUMN IF NOT EXISTS operation_case_id UUID
  REFERENCES public.operations_cases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notification_log_operation_case
  ON public.notification_log (operation_case_id, sent_at DESC)
  WHERE operation_case_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_operations_case_v1(
  p_case_ref TEXT,
  p_case_type TEXT,
  p_source TEXT,
  p_source_ref TEXT,
  p_severity TEXT,
  p_subject TEXT,
  p_description TEXT,
  p_booking_id UUID,
  p_customer_name TEXT,
  p_customer_email TEXT,
  p_customer_phone TEXT,
  p_easer_id UUID,
  p_created_by_type TEXT,
  p_created_by_name TEXT,
  p_metadata JSONB
)
RETURNS SETOF public.operations_cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.operations_cases%ROWTYPE;
BEGIN
  IF p_case_ref IS NULL OR p_case_ref !~ '^[A-Z0-9-]{8,48}$' THEN
    RAISE EXCEPTION 'Invalid case reference' USING ERRCODE = '22023';
  END IF;

  SELECT case_row.*
    INTO v_case
    FROM public.operations_cases case_row
   WHERE case_row.case_ref = p_case_ref
      OR (
        p_source_ref IS NOT NULL
        AND case_row.source = p_source
        AND case_row.source_ref = p_source_ref
      )
   ORDER BY CASE WHEN case_row.case_ref = p_case_ref THEN 0 ELSE 1 END
   LIMIT 1;

  IF FOUND THEN
    RETURN NEXT v_case;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.operations_cases (
      case_ref, case_type, source, source_ref, status, severity,
      subject, description, booking_id,
      customer_name, customer_email, customer_phone, easer_id,
      created_by_type, created_by_name
    ) VALUES (
      p_case_ref, p_case_type, p_source, NULLIF(btrim(COALESCE(p_source_ref, '')), ''),
      'open', p_severity,
      btrim(p_subject), btrim(p_description), p_booking_id,
      NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
      NULLIF(lower(btrim(COALESCE(p_customer_email, ''))), ''),
      NULLIF(btrim(COALESCE(p_customer_phone, '')), ''),
      p_easer_id, p_created_by_type,
      NULLIF(btrim(COALESCE(p_created_by_name, '')), '')
    )
    RETURNING * INTO v_case;
  EXCEPTION WHEN unique_violation THEN
    SELECT case_row.*
      INTO v_case
      FROM public.operations_cases case_row
     WHERE case_row.case_ref = p_case_ref
        OR (
          p_source_ref IS NOT NULL
          AND case_row.source = p_source
          AND case_row.source_ref = p_source_ref
        )
     LIMIT 1;
    IF NOT FOUND THEN RAISE; END IF;
  END;

  IF NOT EXISTS (
    SELECT 1
      FROM public.operations_case_events event
     WHERE event.case_id = v_case.id
       AND event.event_type = 'created'
  ) THEN
    INSERT INTO public.operations_case_events (
      case_id, event_type, actor_type, actor_name,
      to_status, note, public_message, metadata
    ) VALUES (
      v_case.id, 'created', p_created_by_type,
      NULLIF(btrim(COALESCE(p_created_by_name, '')), ''),
      'open', 'Case created: ' || v_case.subject,
      'We received your request.', COALESCE(p_metadata, '{}'::JSONB)
    );
  END IF;

  RETURN NEXT v_case;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_operations_case_v1(
  p_case_id UUID,
  p_expected_status TEXT,
  p_target_status TEXT,
  p_actor_type TEXT,
  p_actor_id UUID,
  p_actor_name TEXT,
  p_note TEXT,
  p_public_message TEXT,
  p_confirmed BOOLEAN
)
RETURNS SETOF public.operations_cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.operations_cases%ROWTYPE;
  v_from_status TEXT;
  v_allowed TEXT[];
  v_now TIMESTAMPTZ := NOW();
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_public_message TEXT := NULLIF(btrim(COALESCE(p_public_message, '')), '');
BEGIN
  SELECT case_row.*
    INTO v_case
    FROM public.operations_cases case_row
   WHERE case_row.id = p_case_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operations case not found' USING ERRCODE = 'P0002';
  END IF;

  v_from_status := v_case.status;
  IF p_expected_status IS NULL OR p_expected_status IS DISTINCT FROM v_from_status THEN
    RAISE EXCEPTION 'Operations case changed; refresh before updating it' USING ERRCODE = '40001';
  END IF;

  v_allowed := CASE v_from_status
    WHEN 'open' THEN ARRAY['acknowledged', 'in_progress', 'resolved', 'closed']
    WHEN 'acknowledged' THEN ARRAY['in_progress', 'waiting_customer', 'waiting_easer', 'resolved', 'closed']
    WHEN 'in_progress' THEN ARRAY['waiting_customer', 'waiting_easer', 'resolved', 'closed']
    WHEN 'waiting_customer' THEN ARRAY['in_progress', 'waiting_easer', 'resolved', 'closed']
    WHEN 'waiting_easer' THEN ARRAY['in_progress', 'waiting_customer', 'resolved', 'closed']
    WHEN 'resolved' THEN ARRAY['in_progress', 'closed']
    WHEN 'closed' THEN ARRAY['in_progress']
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (p_target_status = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid operations case status transition: % to %', v_from_status, p_target_status
      USING ERRCODE = '22023';
  END IF;

  IF p_actor_type NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'This transition requires an owner or system actor' USING ERRCODE = '42501';
  END IF;

  IF char_length(COALESCE(v_note, '')) > 4000
     OR char_length(COALESCE(v_public_message, '')) > 2000 THEN
    RAISE EXCEPTION 'Case update text is too long' USING ERRCODE = '22023';
  END IF;

  IF p_target_status IN ('resolved', 'closed') THEN
    IF p_confirmed IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Confirmation is required to resolve or close a case' USING ERRCODE = '22023';
    END IF;
    IF char_length(COALESCE(v_note, '')) < 10 THEN
      RAISE EXCEPTION 'A resolution note of at least 10 characters is required' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_from_status IN ('resolved', 'closed') AND p_target_status = 'in_progress'
     AND p_confirmed IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Confirmation is required to reopen a case' USING ERRCODE = '22023';
  END IF;
  IF v_from_status IN ('resolved', 'closed') AND p_target_status = 'in_progress'
     AND char_length(COALESCE(v_note, '')) < 10 THEN
    RAISE EXCEPTION 'A reopen note of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_target_status IN ('waiting_customer', 'waiting_easer')
     AND char_length(COALESCE(v_note, '')) < 5 THEN
    RAISE EXCEPTION 'A note explaining what is needed is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.operations_cases case_row
     SET status = p_target_status,
         acknowledged_at = CASE
           WHEN p_target_status <> 'open' THEN COALESCE(case_row.acknowledged_at, v_now)
           ELSE case_row.acknowledged_at
         END,
         resolved_at = CASE
           WHEN p_target_status IN ('resolved', 'closed') THEN COALESCE(case_row.resolved_at, v_now)
           WHEN v_from_status IN ('resolved', 'closed') AND p_target_status = 'in_progress' THEN NULL
           ELSE case_row.resolved_at
         END,
         closed_at = CASE
           WHEN p_target_status = 'closed' THEN v_now
           WHEN v_from_status = 'closed' AND p_target_status = 'in_progress' THEN NULL
           ELSE case_row.closed_at
         END,
         resolution_summary = CASE
           WHEN p_target_status = 'resolved' THEN v_note
           WHEN p_target_status = 'closed' THEN COALESCE(case_row.resolution_summary, v_note)
           WHEN v_from_status IN ('resolved', 'closed') AND p_target_status = 'in_progress' THEN NULL
           ELSE case_row.resolution_summary
         END,
         last_public_update_at = CASE
           WHEN v_public_message IS NOT NULL THEN v_now
           ELSE case_row.last_public_update_at
         END,
         updated_at = v_now
   WHERE case_row.id = p_case_id
   RETURNING * INTO v_case;

  INSERT INTO public.operations_case_events (
    case_id, event_type, actor_type, actor_id, actor_name,
    from_status, to_status, note, public_message, metadata
  ) VALUES (
    v_case.id, 'status_changed', p_actor_type, p_actor_id,
    NULLIF(btrim(COALESCE(p_actor_name, '')), ''),
    v_from_status, p_target_status, v_note, v_public_message,
    jsonb_build_object('confirmed', p_confirmed IS TRUE)
  );

  RETURN NEXT v_case;
END;
$$;

CREATE OR REPLACE FUNCTION public.append_operations_case_event_v1(
  p_case_id UUID,
  p_event_type TEXT,
  p_actor_type TEXT,
  p_actor_id UUID,
  p_actor_name TEXT,
  p_note TEXT,
  p_public_message TEXT,
  p_metadata JSONB
)
RETURNS SETOF public.operations_case_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.operations_cases%ROWTYPE;
  v_event public.operations_case_events%ROWTYPE;
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_public_message TEXT := NULLIF(btrim(COALESCE(p_public_message, '')), '');
BEGIN
  IF p_event_type NOT IN ('internal_note', 'notification_attempted', 'public_update', 'linkage_updated') THEN
    RAISE EXCEPTION 'Invalid operations case event type' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type NOT IN ('owner', 'customer', 'easer', 'system', 'stripe') THEN
    RAISE EXCEPTION 'Invalid operations case event actor' USING ERRCODE = '22023';
  END IF;
  IF char_length(COALESCE(v_note, '')) > 4000
     OR char_length(COALESCE(v_public_message, '')) > 2000 THEN
    RAISE EXCEPTION 'Case event text is too long' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NULL AND v_public_message IS NULL AND COALESCE(p_metadata, '{}'::JSONB) = '{}'::JSONB THEN
    RAISE EXCEPTION 'Case event content is required' USING ERRCODE = '22023';
  END IF;

  SELECT case_row.*
    INTO v_case
    FROM public.operations_cases case_row
   WHERE case_row.id = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operations case not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.operations_case_events (
    case_id, event_type, actor_type, actor_id, actor_name,
    from_status, to_status, note, public_message, metadata
  ) VALUES (
    v_case.id, p_event_type, p_actor_type, p_actor_id,
    NULLIF(btrim(COALESCE(p_actor_name, '')), ''),
    v_case.status, v_case.status, v_note, v_public_message,
    COALESCE(p_metadata, '{}'::JSONB)
  )
  RETURNING * INTO v_event;

  UPDATE public.operations_cases case_row
     SET updated_at = NOW(),
         last_public_update_at = CASE
           WHEN v_public_message IS NOT NULL THEN NOW()
           ELSE case_row.last_public_update_at
         END
   WHERE case_row.id = v_case.id;

  RETURN NEXT v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.create_operations_case_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID,
  TEXT, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_operations_case_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID,
  TEXT, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) TO service_role;

REVOKE ALL ON FUNCTION public.transition_operations_case_v1(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_operations_case_v1(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, BOOLEAN
) TO service_role;

REVOKE ALL ON FUNCTION public.append_operations_case_event_v1(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_operations_case_event_v1(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (53, 'operations_cases')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
