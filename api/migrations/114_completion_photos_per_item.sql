-- ============================================================
-- Migration 114: require and store completion photos per booked unit
--
-- Completion is evidence of the booked scope, not merely evidence that one
-- image was uploaded. The server and these row-locked RPCs use the same
-- quantity-aware count; five additional files remain available for other
-- evidence such as before photos and damage reports.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.booking_required_completion_photo_count(
  p_booking_id UUID
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(
    1,
    COALESCE(SUM(GREATEST(COALESCE(item.quantity, 1), 1)), 0)::INTEGER
  )
    FROM public.booking_items item
   WHERE item.booking_id = p_booking_id
     AND item.is_add_on IS NOT TRUE
     AND NULLIF(BTRIM(item.item_name), '') IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.booking_required_completion_photo_count(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_required_completion_photo_count(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.booking_required_completion_photo_counts(
  p_booking_ids UUID[]
)
RETURNS TABLE (
  booking_id UUID,
  required_photo_count INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT requested.booking_id,
         public.booking_required_completion_photo_count(requested.booking_id)
    FROM UNNEST(p_booking_ids) AS requested(booking_id);
$$;

REVOKE ALL ON FUNCTION public.booking_required_completion_photo_counts(UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_required_completion_photo_counts(UUID[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.request_booking_evidence_hold(
  p_booking_id UUID
)
RETURNS TABLE (
  booking_id UUID,
  booking_ref TEXT,
  booking_status TEXT,
  assembler_id UUID,
  assembler_name TEXT,
  service TEXT,
  booking_date TEXT,
  evidence_requested_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_requested_at TIMESTAMPTZ;
  v_evidence_count INTEGER;
  v_required_photo_count INTEGER;
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_booking.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'Evidence can only be requested for completed jobs' USING ERRCODE = '23514';
  END IF;
  IF v_booking.assembler_id IS NULL THEN
    RAISE EXCEPTION 'No Easer is assigned to this booking' USING ERRCODE = '23514';
  END IF;
  IF v_booking.evidence_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Evidence has already been requested for this booking' USING ERRCODE = '23505';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'A financial operation is active; evidence cannot be requested now' USING ERRCODE = '55P03';
  END IF;
  IF v_booking.payout_status IN ('paid', 'transferred')
     OR v_booking.cancellation_easer_payout_status IN ('paid', 'transferred')
     OR v_booking.stripe_transfer_id IS NOT NULL
     OR COALESCE(v_booking.payout_amount, 0) > 0
     OR v_booking.paid_out_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.payout_ledger ledger WHERE ledger.booking_id = v_booking.id) THEN
    RAISE EXCEPTION 'Evidence cannot be requested after Easer payment or transfer' USING ERRCODE = '23514';
  END IF;

  v_required_photo_count := public.booking_required_completion_photo_count(v_booking.id);
  SELECT COUNT(*)::INTEGER INTO v_evidence_count
    FROM public.booking_evidence evidence
   WHERE evidence.booking_id = v_booking.id;
  IF v_evidence_count >= v_required_photo_count + 5 THEN
    RAISE EXCEPTION 'Evidence cannot be requested because this booking has reached its evidence limit' USING ERRCODE = '23514';
  END IF;

  v_requested_at := NOW();
  UPDATE public.bookings
     SET evidence_requested_at = v_requested_at
   WHERE id = v_booking.id;

  RETURN QUERY SELECT v_booking.id, v_booking.ref, v_booking.status,
    v_booking.assembler_id, v_booking.assembler_name, v_booking.service,
    v_booking.date::TEXT, v_requested_at;
END;
$$;

REVOKE ALL ON FUNCTION public.request_booking_evidence_hold(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_booking_evidence_hold(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_booking_evidence(
  p_booking_id UUID,
  p_uploaded_by UUID,
  p_storage_path TEXT,
  p_evidence_type TEXT,
  p_mime_type TEXT,
  p_file_size_bytes INTEGER,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  evidence_id UUID,
  evidence_type TEXT,
  mime_type TEXT,
  file_size_bytes INTEGER,
  created_at TIMESTAMPTZ,
  damage_review_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.booking_evidence%ROWTYPE;
  v_evidence public.booking_evidence%ROWTYPE;
  v_evidence_count INTEGER;
  v_required_photo_count INTEGER;
  v_clean_notes TEXT := NULLIF(BTRIM(COALESCE(p_notes, '')), '');
BEGIN
  IF p_evidence_type NOT IN ('completion_photo', 'before_photo', 'damage_claim') THEN
    RAISE EXCEPTION 'Unsupported Easer evidence type: %', p_evidence_type USING ERRCODE = '22000';
  END IF;
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif') THEN
    RAISE EXCEPTION 'Unsupported evidence MIME type: %', p_mime_type USING ERRCODE = '22000';
  END IF;
  IF p_file_size_bytes IS NULL OR p_file_size_bytes <= 0 OR p_file_size_bytes > 5242880 THEN
    RAISE EXCEPTION 'Evidence file size must be between 1 byte and 5 MB' USING ERRCODE = '22000';
  END IF;
  IF CHAR_LENGTH(COALESCE(v_clean_notes, '')) > 2000
     OR (p_evidence_type = 'damage_claim' AND CHAR_LENGTH(COALESCE(v_clean_notes, '')) < 10) THEN
    RAISE EXCEPTION 'Evidence notes do not meet the required length' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(BTRIM(p_storage_path), '') = ''
     OR p_storage_path NOT LIKE ('evidence/' || v_booking.id::TEXT || '/%') THEN
    RAISE EXCEPTION 'Evidence storage path does not match the booking' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_existing
    FROM public.booking_evidence evidence
   WHERE evidence.storage_path = p_storage_path;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM v_booking.id
       OR v_existing.uploaded_by IS DISTINCT FROM p_uploaded_by
       OR v_existing.evidence_type IS DISTINCT FROM p_evidence_type
       OR v_existing.mime_type IS DISTINCT FROM p_mime_type
       OR v_existing.file_size_bytes IS DISTINCT FROM p_file_size_bytes THEN
      RAISE EXCEPTION 'Evidence storage path is already linked to different evidence' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.evidence_type,
      v_existing.mime_type, v_existing.file_size_bytes, v_existing.created_at,
      v_booking.damage_review_status;
    RETURN;
  END IF;

  IF v_booking.assembler_id IS DISTINCT FROM p_uploaded_by THEN
    RAISE EXCEPTION 'Booking is not assigned to this Easer' USING ERRCODE = '42501';
  END IF;
  IF v_booking.assembler_accepted_at IS NULL THEN
    RAISE EXCEPTION 'The Easer must accept the assignment before uploading evidence' USING ERRCODE = '23514';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'A financial operation is active; evidence cannot be uploaded now' USING ERRCODE = '55P03';
  END IF;
  IF p_evidence_type = 'before_photo'
     AND v_booking.status NOT IN ('arrived', 'in_progress') THEN
    RAISE EXCEPTION 'Before photos require an arrived or in-progress job' USING ERRCODE = '23514';
  ELSIF p_evidence_type = 'completion_photo'
     AND (v_booking.status NOT IN ('in_progress', 'completed') OR v_booking.job_started_at IS NULL) THEN
    RAISE EXCEPTION 'Completion photos require work to have started' USING ERRCODE = '23514';
  ELSIF p_evidence_type = 'damage_claim'
     AND v_booking.status NOT IN ('arrived', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Damage evidence requires an arrived, in-progress, or completed job' USING ERRCODE = '23514';
  END IF;

  v_required_photo_count := public.booking_required_completion_photo_count(v_booking.id);
  SELECT COUNT(*)::INTEGER INTO v_evidence_count
    FROM public.booking_evidence evidence
   WHERE evidence.booking_id = v_booking.id;
  IF v_evidence_count >= v_required_photo_count + 5 THEN
    RAISE EXCEPTION 'Maximum evidence files for this booking reached' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.booking_evidence (
    booking_id, uploaded_by, storage_path, evidence_type, mime_type,
    file_size_bytes, visibility, notes
  ) VALUES (
    v_booking.id, p_uploaded_by, BTRIM(p_storage_path), p_evidence_type,
    p_mime_type, p_file_size_bytes, 'owner', v_clean_notes
  ) RETURNING * INTO v_evidence;

  IF p_evidence_type = 'damage_claim' THEN
    UPDATE public.bookings
       SET damage_review_status = 'review_required',
           damage_claim_opened_at = v_evidence.created_at,
           damage_reviewed_at = NULL,
           damage_reviewed_by = NULL,
           damage_review_notes = NULL
     WHERE id = v_booking.id;
    v_booking.damage_review_status := 'review_required';
  END IF;

  RETURN QUERY SELECT v_evidence.id, v_evidence.evidence_type,
    v_evidence.mime_type, v_evidence.file_size_bytes, v_evidence.created_at,
    v_booking.damage_review_status;
END;
$$;

REVOKE ALL ON FUNCTION public.record_booking_evidence(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_booking_evidence(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_owner_manual_completion_evidence(
  p_booking_id UUID,
  p_uploaded_by UUID,
  p_storage_path TEXT,
  p_mime_type TEXT,
  p_file_size_bytes INTEGER,
  p_notes TEXT
)
RETURNS TABLE (
  evidence_id UUID,
  evidence_type TEXT,
  mime_type TEXT,
  file_size_bytes INTEGER,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_existing public.booking_evidence%ROWTYPE;
  v_evidence public.booking_evidence%ROWTYPE;
  v_count INTEGER;
  v_required_photo_count INTEGER;
  v_notes TEXT := NULLIF(BTRIM(COALESCE(p_notes, '')), '');
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
    FROM public.booking_evidence evidence
   WHERE evidence.storage_path = p_storage_path;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.uploaded_by IS DISTINCT FROM p_uploaded_by
       OR v_existing.evidence_type IS DISTINCT FROM 'completion_photo' THEN
      RAISE EXCEPTION 'Evidence path is already linked to different evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.evidence_type,
      v_existing.mime_type, v_existing.file_size_bytes, v_existing.created_at;
    RETURN;
  END IF;

  SELECT * INTO v_profile
    FROM public.profiles
   WHERE id = p_uploaded_by
     AND role = 'assembler'
     AND is_owner IS TRUE;
  IF NOT FOUND
     OR v_booking.source IS DISTINCT FROM 'owner_manual'
     OR v_booking.payment_status IS DISTINCT FROM 'offline_recorded'
     OR v_booking.status IS DISTINCT FROM 'completed'
     OR v_booking.assembler_id IS DISTINCT FROM p_uploaded_by THEN
    RAISE EXCEPTION 'Historical evidence requires a completed owner booking linked to the owner-Easer'
      USING ERRCODE = '42501';
  END IF;
  IF v_booking.financial_operation_key IS NOT NULL
     OR v_booking.financial_operation_type IS NOT NULL
     OR v_booking.financial_operation_started_at IS NOT NULL
     OR v_booking.financial_reconciliation_required_at IS NOT NULL THEN
    RAISE EXCEPTION 'A financial operation is active; evidence cannot be uploaded now'
      USING ERRCODE = '55P03';
  END IF;
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
     OR p_file_size_bytes IS NULL
     OR p_file_size_bytes <= 0
     OR p_file_size_bytes > 5242880
     OR CHAR_LENGTH(COALESCE(v_notes, '')) < 10
     OR CHAR_LENGTH(COALESCE(v_notes, '')) > 2000
     OR COALESCE(BTRIM(p_storage_path), '') = ''
     OR p_storage_path NOT LIKE ('evidence/' || v_booking.id::TEXT || '/%') THEN
    RAISE EXCEPTION 'Historical evidence file or notes are invalid'
      USING ERRCODE = '22000';
  END IF;

  v_required_photo_count := public.booking_required_completion_photo_count(v_booking.id);
  SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.booking_evidence evidence
   WHERE evidence.booking_id = v_booking.id;
  IF v_count >= v_required_photo_count + 5 THEN
    RAISE EXCEPTION 'Maximum evidence files for this booking reached'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.booking_evidence (
    booking_id, uploaded_by, storage_path, evidence_type, mime_type,
    file_size_bytes, visibility, notes
  ) VALUES (
    v_booking.id, p_uploaded_by, BTRIM(p_storage_path), 'completion_photo',
    p_mime_type, p_file_size_bytes, 'owner', v_notes
  ) RETURNING * INTO v_evidence;

  RETURN QUERY SELECT v_evidence.id, v_evidence.evidence_type,
    v_evidence.mime_type, v_evidence.file_size_bytes, v_evidence.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_owner_manual_completion_evidence(
  UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_manual_completion_evidence(
  UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_completion_evidence_on_behalf(
  p_booking_id UUID,
  p_uploaded_by UUID,
  p_uploaded_on_behalf_of UUID,
  p_storage_path TEXT,
  p_mime_type TEXT,
  p_file_size_bytes INTEGER,
  p_notes TEXT
)
RETURNS TABLE (
  evidence_id UUID,
  evidence_type TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_owner public.profiles%ROWTYPE;
  v_existing public.booking_evidence%ROWTYPE;
  v_evidence public.booking_evidence%ROWTYPE;
  v_count INTEGER;
  v_required_photo_count INTEGER;
  v_notes TEXT := NULLIF(BTRIM(COALESCE(p_notes, '')), '');
BEGIN
  SELECT * INTO v_booking
    FROM public.bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_existing
    FROM public.booking_evidence evidence
   WHERE evidence.storage_path = p_storage_path;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.uploaded_by IS DISTINCT FROM p_uploaded_by
       OR v_existing.uploaded_on_behalf_of IS DISTINCT FROM p_uploaded_on_behalf_of
       OR v_existing.evidence_type IS DISTINCT FROM 'completion_photo' THEN
      RAISE EXCEPTION 'Evidence path is already linked to different evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.evidence_type, v_existing.created_at;
    RETURN;
  END IF;

  SELECT * INTO v_owner
    FROM public.profiles
   WHERE id = p_uploaded_by
     AND is_owner IS TRUE;
  IF NOT FOUND OR v_booking.assembler_id IS DISTINCT FROM p_uploaded_on_behalf_of THEN
    RAISE EXCEPTION 'Evidence can only be supplied by the owner for the assigned Easer'
      USING ERRCODE = '42501';
  END IF;
  IF v_booking.status NOT IN ('in_progress', 'completed')
     OR (v_booking.status = 'in_progress' AND v_booking.job_started_at IS NULL)
     OR v_booking.financial_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'Completion evidence cannot be supplied in this booking state'
      USING ERRCODE = '23514';
  END IF;
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
     OR p_file_size_bytes IS NULL
     OR p_file_size_bytes <= 0
     OR p_file_size_bytes > 5242880
     OR CHAR_LENGTH(COALESCE(v_notes, '')) < 10
     OR CHAR_LENGTH(COALESCE(v_notes, '')) > 2000
     OR COALESCE(BTRIM(p_storage_path), '') = ''
     OR p_storage_path NOT LIKE ('evidence/' || v_booking.id::TEXT || '/%') THEN
    RAISE EXCEPTION 'Completion evidence file or notes are invalid'
      USING ERRCODE = '22000';
  END IF;

  v_required_photo_count := public.booking_required_completion_photo_count(v_booking.id);
  SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.booking_evidence evidence
   WHERE evidence.booking_id = v_booking.id;
  IF v_count >= v_required_photo_count + 5 THEN
    RAISE EXCEPTION 'Maximum evidence files for this booking reached'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.booking_evidence (
    booking_id, uploaded_by, uploaded_on_behalf_of, storage_path,
    evidence_type, mime_type, file_size_bytes, visibility, notes
  ) VALUES (
    v_booking.id, p_uploaded_by, p_uploaded_on_behalf_of, BTRIM(p_storage_path),
    'completion_photo', p_mime_type, p_file_size_bytes, 'owner', v_notes
  ) RETURNING * INTO v_evidence;

  RETURN QUERY SELECT v_evidence.id, v_evidence.evidence_type, v_evidence.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_completion_evidence_on_behalf(
  UUID, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_completion_evidence_on_behalf(
  UUID, UUID, UUID, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (114, 'completion_photos_per_item')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
