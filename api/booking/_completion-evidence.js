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

export async function loadCurrentCompletionEvidence(sb, booking, { select = 'id, storage_path, evidence_type, uploaded_by, created_at' } = {}) {
  if (!booking?.assembler_id || !booking?.job_started_at) {
    return { evidence: null, error: null, reason: 'work_start_or_assignee_missing' };
  }

  const evidenceRequestedAt = booking.evidence_requested_at
    ? new Date(booking.evidence_requested_at).getTime()
    : null;
  const workStartedAt = new Date(booking.job_started_at).getTime();
  const validAfter = Number.isFinite(evidenceRequestedAt)
    ? Math.max(workStartedAt, evidenceRequestedAt)
    : workStartedAt;
  if (!Number.isFinite(validAfter)) {
    return { evidence: null, error: null, reason: 'work_start_or_assignee_missing' };
  }

  const { data, error } = await sb
    .from('booking_evidence')
    .select(select)
    .eq('booking_id', booking.id)
    .eq('evidence_type', 'completion_photo')
    .eq('uploaded_by', booking.assembler_id)
    .gte('created_at', new Date(validAfter).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { evidence: null, error, reason: 'evidence_lookup_failed' };
  if (!data || !isCurrentCompletionEvidence(data, booking)) {
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
