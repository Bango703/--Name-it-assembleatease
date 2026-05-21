/**
 * Activity log helper — non-fatal, call from any endpoint.
 * Requires push_subscriptions table + activity_logs table in Supabase.
 *
 * eventType examples:
 *   booking_created, confirmed, dispatched, easer_accepted, en_route,
 *   arrived, job_started, completed, cancelled, refunded, note_added,
 *   payout_released, reassigned, incident_opened
 */
export async function logActivity(sb, {
  bookingId, eventType, actorType = 'system',
  actorId = null, actorName = null, description, metadata = null
}) {
  if (!bookingId || !eventType || !description) return;
  try {
    await sb.from('activity_logs').insert({
      booking_id: bookingId,
      event_type: eventType,
      actor_type: actorType,
      actor_id: actorId,
      actor_name: actorName,
      description,
      metadata,
    });
  } catch(e) {
    // Non-fatal — table may not exist yet
    console.warn('Activity log skipped:', e.message);
  }
}
