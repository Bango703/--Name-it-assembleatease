/**
 * adjustActiveJobs — best-effort counter maintenance for active_jobs_today.
 *
 * This counter is an approximation reset nightly by the tier-check cron.
 * The dispatch engine does NOT rely on it for scoring — it always queries
 * the bookings table directly for authoritative same-day workload counts.
 * This function just keeps the profile counter roughly accurate for display.
 *
 * Never throws. Non-fatal by design.
 *
 * @param {object} sb      - Supabase service client
 * @param {string} easerId - Profile UUID to adjust
 * @param {number} delta   - +1 (job gained) or -1 (job released)
 */
export async function adjustActiveJobs(sb, easerId, delta) {
  if (!easerId || delta === 0) return;
  try {
    const rpc = delta > 0 ? 'increment_active_jobs' : 'decrement_active_jobs';
    const { error } = await sb.rpc(rpc, { user_id: easerId });
    if (error) {
      // RPC not yet created — fall back to safe read-modify-write
      const { data } = await sb
        .from('profiles')
        .select('active_jobs_today')
        .eq('id', easerId)
        .single();
      await sb.from('profiles').update({
        active_jobs_today: Math.max(0, (data?.active_jobs_today || 0) + delta),
      }).eq('id', easerId);
    }
  } catch (_) { /* non-fatal */ }
}
