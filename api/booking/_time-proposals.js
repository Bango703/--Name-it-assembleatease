/**
 * THE rules for an Easer-proposed appointment time (migration 110).
 *
 * An assigned Easer who cannot make the booked time proposes another instead of
 * dropping the job (TaskRabbit lets a Tasker reschedule once the client agrees).
 * The customer accepts it on their booking page through the ordinary reschedule
 * path (api/booking/reschedule.js), so every date, slot, limit and card-hold rule
 * still applies; a matching proposal only means that Easer keeps the job.
 */

export const PROPOSAL_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
});

function sameSlot(a, b) {
  const clean = v => String(v || '').trim().replace(/\s*[-–—]\s*/g, ' - ').toUpperCase();
  return clean(a) === clean(b);
}

/** The open proposal for a booking, or null (also null before migration 110). */
export async function loadOpenProposal(sb, bookingId) {
  try {
    const { data, error } = await sb.from('easer_time_proposals')
      .select('id, booking_id, easer_id, proposed_date, proposed_time, note, status, created_at')
      .eq('booking_id', bookingId)
      .eq('status', PROPOSAL_STATUS.PENDING)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return error ? null : (data || null);
  } catch {
    return null;
  }
}

/**
 * Is this reschedule the customer accepting the assigned Easer's proposal?
 * Only an open proposal from the Easer still on the job, for exactly this date
 * and slot, counts.
 */
export async function matchingProposal(sb, { proposalId, booking, date, time }) {
  if (!proposalId || !booking?.assembler_id) return null;
  const open = await loadOpenProposal(sb, booking.id);
  if (!open || open.id !== proposalId) return null;
  if (open.easer_id !== booking.assembler_id) return null;
  if (open.proposed_date !== date || !sameSlot(open.proposed_time, time)) return null;
  return open;
}

/**
 * After a reschedule: the accepted proposal is accepted, any other open one is
 * moot (the time changed some other way). Never throws.
 */
export async function settleProposalsAfterReschedule(sb, bookingId, acceptedId) {
  const now = new Date().toISOString();
  try {
    if (acceptedId) {
      await sb.from('easer_time_proposals')
        .update({ status: PROPOSAL_STATUS.ACCEPTED, responded_at: now })
        .eq('id', acceptedId)
        .eq('status', PROPOSAL_STATUS.PENDING);
    }
    let others = sb.from('easer_time_proposals')
      .update({ status: PROPOSAL_STATUS.EXPIRED, responded_at: now })
      .eq('booking_id', bookingId)
      .eq('status', PROPOSAL_STATUS.PENDING);
    if (acceptedId) others = others.neq('id', acceptedId);
    await others;
  } catch { /* proposals are a convenience; the reschedule stands */ }
}
