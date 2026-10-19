export const EXTRA_EVIDENCE_FILE_LIMIT = 5;

export async function loadRequiredCompletionPhotoCounts(sb, bookingIds) {
  const ids = [...new Set((Array.isArray(bookingIds) ? bookingIds : [bookingIds]).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await sb.rpc('booking_required_completion_photo_counts', {
    p_booking_ids: ids,
  });
  if (error) throw error;
  const counts = new Map((data || []).map(row => [
    row.booking_id,
    Number(row.required_photo_count),
  ]));
  if (ids.some(id => !Number.isInteger(counts.get(id)) || counts.get(id) < 1)) {
    throw new Error('Required completion photo counts were incomplete.');
  }
  return counts;
}

/**
 * @param {object} row      a booking_evidence row
 * @param {object} booking
 * @param {{acceptSuppliedOnBehalf?: boolean}} [opts]
 *   acceptSuppliedOnBehalf accepts a row the OWNER supplied for this Easer
 *   (uploaded_on_behalf_of). Payout-only: it releases money for work already
 *   done. The completion gate never passes it, so an Easer still needs their
 *   own photo to mark a job complete.
 */
export function isCurrentCompletionEvidence(row, booking, { acceptSuppliedOnBehalf = false } = {}) {
  if (!row || !booking?.assembler_id || !booking?.job_started_at) return false;
  if (row.evidence_type !== 'completion_photo') return false;
  const authoredByEaser = row.uploaded_by === booking.assembler_id;
  const suppliedForEaser = acceptSuppliedOnBehalf && row.uploaded_on_behalf_of === booking.assembler_id;
  if (!authoredByEaser && !suppliedForEaser) return false;

  const createdAt = new Date(row.created_at).getTime();
  const workStartedAt = new Date(booking.job_started_at).getTime();
  const evidenceRequestedAt = booking.evidence_requested_at
    ? new Date(booking.evidence_requested_at).getTime()
    : null;
  const validAfter = Number.isFinite(evidenceRequestedAt)
    ? Math.max(workStartedAt, evidenceRequestedAt)
    : workStartedAt;
  return Number.isFinite(createdAt) && Number.isFinite(validAfter) && createdAt >= validAfter;
}

export function summarizeCurrentCompletionPhotos(rows, booking, requiredPhotoCount, {
  acceptSuppliedOnBehalf = false,
} = {}) {
  const bookingWithoutRequest = { ...booking, evidence_requested_at: null };
  const validRows = (rows || []).filter(row =>
    isCurrentCompletionEvidence(row, bookingWithoutRequest, { acceptSuppliedOnBehalf }));
  const requestAt = booking.evidence_requested_at
    ? new Date(booking.evidence_requested_at).getTime()
    : null;
  if (booking.evidence_requested_at && !Number.isFinite(requestAt)) {
    return {
      evidence: validRows[0] || null,
      evidenceCount: validRows.length,
      evidenceCountAfterRequest: 0,
      requiredPhotoCount,
      requiredAfterRequestCount: requiredPhotoCount,
      satisfied: false,
      reason: 'invalid_evidence_request_at',
    };
  }

  const priorRequestCount = Number.isFinite(requestAt)
    ? validRows.filter(row => new Date(row.created_at).getTime() < requestAt).length
    : 0;
  const evidenceCountAfterRequest = Number.isFinite(requestAt)
    ? validRows.length - priorRequestCount
    : validRows.length;
  const requiredAfterRequestCount = Number.isFinite(requestAt)
    ? Math.max(1, requiredPhotoCount - priorRequestCount)
    : requiredPhotoCount;

  return {
    evidence: validRows[0] || null,
    evidenceCount: validRows.length,
    evidenceCountAfterRequest,
    requiredPhotoCount,
    requiredAfterRequestCount,
    satisfied: evidenceCountAfterRequest >= requiredAfterRequestCount,
    reason: evidenceCountAfterRequest >= requiredAfterRequestCount
      ? null
      : Number.isFinite(requestAt)
        ? 'post_request_completion_photos_incomplete'
        : 'completion_photos_incomplete',
  };
}

/**
 * The visibility value that means "a human decided a customer may see this".
 * booking_evidence.visibility defaults to 'owner', so an Easer upload is
 * INTERNAL until someone deliberately promotes it.
 */
export const CUSTOMER_FACING_VISIBILITY = 'all';

/**
 * The photo a customer is allowed to see.
 *
 * WHY THIS IS A SEPARATE FUNCTION FROM loadCurrentCompletionEvidence
 * Two different questions were being answered by one query:
 *
 *   "Did the Easer provide completion evidence?"  — gates completion
 *   "May the customer be shown this image?"       — gates publication
 *
 * Conflating them meant every photo an Easer uploaded was emailed to the
 * customer and embedded on the tracking page behind a 30-day signed URL, even
 * though booking_evidence.visibility defaults to 'owner'. A selfie, an ID, a
 * photo of the wrong room — anything the Easer's camera produced went straight
 * to the customer. The column that should have stopped it was never read.
 *
 * Completion still requires a photo. Publishing one now requires a decision.
 */
export async function loadCustomerFacingCompletionPhoto(sb, booking, opts = {}) {
  return loadCurrentCompletionEvidence(sb, booking, {
    ...opts,
    select: 'id, storage_path, evidence_type, uploaded_by, uploaded_on_behalf_of, created_at, visibility',
    customerFacingOnly: true,
  });
}

export async function loadCurrentCompletionEvidence(sb, booking, {
  select = 'id, storage_path, evidence_type, uploaded_by, uploaded_on_behalf_of, created_at',
  allowHistoricalOwnerManual = false,
  customerFacingOnly = false,
  requireAllPhotos = false,
  // Payout only. Accepts evidence the OWNER supplied for this Easer, recorded
  // honestly via uploaded_on_behalf_of. Never enabled on the completion gate:
  // an Easer still needs their own photo to mark a job done.
  acceptSuppliedOnBehalf = false,
} = {}) {
  if (!booking?.assembler_id) {
    return { evidence: null, error: null, reason: 'work_start_or_assignee_missing' };
  }

  const historicalOwnerManual = allowHistoricalOwnerManual
    && booking.source === 'owner_manual'
    && booking.payment_status === 'offline_recorded'
    && booking.status === 'completed'
    && !booking.job_started_at
    && Boolean(booking.completed_at);
  if (!booking.job_started_at && !historicalOwnerManual) {
    return { evidence: null, error: null, reason: 'work_start_or_assignee_missing' };
  }

  const evidenceRequestedAt = booking.evidence_requested_at
    ? new Date(booking.evidence_requested_at).getTime()
    : null;
  const workStartedAt = new Date(historicalOwnerManual ? booking.completed_at : booking.job_started_at).getTime();
  const validAfter = Number.isFinite(evidenceRequestedAt)
    ? Math.max(workStartedAt, evidenceRequestedAt)
    : workStartedAt;
  if (!Number.isFinite(validAfter)) {
    return { evidence: null, error: null, reason: 'work_start_or_assignee_missing' };
  }

  let requiredPhotoCount = 1;
  if (requireAllPhotos) {
    try {
      const counts = await loadRequiredCompletionPhotoCounts(sb, [booking.id]);
      requiredPhotoCount = counts.get(booking.id);
    } catch (error) {
      return { evidence: null, error, reason: 'booking_items_lookup_failed' };
    }
  }

  const queryAfter = requireAllPhotos && booking.evidence_requested_at
    ? (historicalOwnerManual ? validAfter : workStartedAt)
    : validAfter;
  let query = sb
    .from('booking_evidence')
    .select(select)
    .eq('booking_id', booking.id)
    .eq('evidence_type', 'completion_photo')
    .gte('created_at', new Date(queryAfter).toISOString());

  // The default path keeps the exact single-column filter it always had.
  // Only the payout path widens to include evidence the owner supplied FOR
  // this Easer, so nothing else changes shape.
  query = acceptSuppliedOnBehalf
    ? query.or(`uploaded_by.eq.${booking.assembler_id},uploaded_on_behalf_of.eq.${booking.assembler_id}`)
    : query.eq('uploaded_by', booking.assembler_id);

  // Only a photo somebody deliberately promoted may leave the building.
  if (customerFacingOnly) query = query.eq('visibility', CUSTOMER_FACING_VISIBILITY);

  query = query.order('created_at', { ascending: false });
  let evidenceData;
  let error;
  if (requireAllPhotos) {
    ({ data: evidenceData, error } = await query
      .limit(requiredPhotoCount + EXTRA_EVIDENCE_FILE_LIMIT));
  } else {
    const result = await query.limit(1).maybeSingle();
    evidenceData = result.data;
    error = result.error;
  }

  if (error) return { evidence: null, error, reason: 'evidence_lookup_failed' };
  const rows = Array.isArray(evidenceData) ? evidenceData : evidenceData ? [evidenceData] : [];
  const data = rows[0] || null;
  const validRows = historicalOwnerManual
    ? rows.filter(row => row.evidence_type === 'completion_photo'
      && row.uploaded_by === booking.assembler_id
      && new Date(row.created_at).getTime() >= validAfter)
    : rows.filter(row => isCurrentCompletionEvidence(
      row,
      requireAllPhotos && booking.evidence_requested_at
        ? { ...booking, evidence_requested_at: null }
        : booking,
      { acceptSuppliedOnBehalf },
    ));
  const customerVisibleRows = customerFacingOnly
    ? validRows.filter(row => row.visibility === CUSTOMER_FACING_VISIBILITY)
    : validRows;
  const summary = requireAllPhotos
    ? summarizeCurrentCompletionPhotos(validRows, booking, requiredPhotoCount, { acceptSuppliedOnBehalf })
    : null;
  const evidence = customerVisibleRows[0] || null;
  const evidenceIsValid = validRows.length > 0;
  const visibilityOk = !customerFacingOnly || data?.visibility === CUSTOMER_FACING_VISIBILITY;
  const evidenceCount = summary?.evidenceCount ?? (evidence ? 1 : 0);
  const satisfied = summary?.satisfied ?? Boolean(evidence);

  if (!evidence || !evidenceIsValid || !visibilityOk || (requireAllPhotos && !satisfied)) {
    if (customerFacingOnly && data && evidenceIsValid && !visibilityOk) {
      return {
        evidence: null,
        error: null,
        evidenceCount,
        requiredPhotoCount,
        evidenceCountAfterRequest: summary?.evidenceCountAfterRequest ?? evidenceCount,
        requiredAfterRequestCount: summary?.requiredAfterRequestCount ?? requiredPhotoCount,
        satisfied: false,
        reason: 'not_approved_for_customer',
      };
    }
    return {
      evidence,
      error: null,
      evidenceCount,
      requiredPhotoCount,
      evidenceCountAfterRequest: summary?.evidenceCountAfterRequest ?? evidenceCount,
      requiredAfterRequestCount: summary?.requiredAfterRequestCount ?? requiredPhotoCount,
      satisfied: false,
      reason: summary?.reason || (booking.evidence_requested_at
        ? 'post_request_completion_evidence_missing'
        : 'valid_completion_photo_missing'),
    };
  }
  return {
    evidence,
    error: null,
    evidenceCount,
    requiredPhotoCount,
    evidenceCountAfterRequest: summary?.evidenceCountAfterRequest ?? evidenceCount,
    requiredAfterRequestCount: summary?.requiredAfterRequestCount ?? requiredPhotoCount,
    satisfied: true,
    reason: null,
  };
}
