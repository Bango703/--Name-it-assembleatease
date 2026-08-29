export function isCurrentCompletionEvidence(row, booking) {
  if (!row || !booking?.assembler_id || !booking?.job_started_at) return false;
  if (row.evidence_type !== 'completion_photo') return false;
  if (row.uploaded_by !== booking.assembler_id) return false;

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
    select: 'id, storage_path, evidence_type, uploaded_by, created_at, visibility',
    customerFacingOnly: true,
  });
}

export async function loadCurrentCompletionEvidence(sb, booking, {
  select = 'id, storage_path, evidence_type, uploaded_by, created_at',
  allowHistoricalOwnerManual = false,
  customerFacingOnly = false,
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

  let query = sb
    .from('booking_evidence')
    .select(select)
    .eq('booking_id', booking.id)
    .eq('evidence_type', 'completion_photo')
    .eq('uploaded_by', booking.assembler_id)
    .gte('created_at', new Date(validAfter).toISOString());

  // Only a photo somebody deliberately promoted may leave the building.
  if (customerFacingOnly) query = query.eq('visibility', CUSTOMER_FACING_VISIBILITY);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { evidence: null, error, reason: 'evidence_lookup_failed' };
  const evidenceIsValid = historicalOwnerManual
    ? Boolean(data
      && data.evidence_type === 'completion_photo'
      && data.uploaded_by === booking.assembler_id
      && new Date(data.created_at).getTime() >= validAfter)
    : isCurrentCompletionEvidence(data, booking);
  const visibilityOk = !customerFacingOnly || data?.visibility === CUSTOMER_FACING_VISIBILITY;
  if (!data || !evidenceIsValid || !visibilityOk) {
    if (customerFacingOnly && data && evidenceIsValid && !visibilityOk) {
      return { evidence: null, error: null, reason: 'not_approved_for_customer' };
    }
    return {
      evidence: null,
      error: null,
      reason: booking.evidence_requested_at
        ? 'post_request_completion_evidence_missing'
        : 'valid_completion_photo_missing',
    };
  }
  return { evidence: data, error: null, reason: null };
}
