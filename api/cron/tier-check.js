import { getSupabase } from '../_supabase.js';

/**
 * GET /api/cron/tier-check
 * Auto-promotes Easer tiers based on performance.
 * Runs daily at 7AM UTC.
 *
 * Requires:
 *   status = 'active'       (only active Easers are promoted)
 *   identity_verified = true
 *
 * Rules:
 *   starter → professional: 10+ completed_jobs AND 4.5+ rating
 *   professional → elite:   30+ completed_jobs AND 4.8+ rating
 */
export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();

  // ── Phase 0a: Reset active_jobs_today for all Easers ─────────────────────
  // This column powers the overload penalty in dispatch scoring (-50 per extra
  // job today). Without a daily reset it only ever grows and penalises everyone.
  const { error: resetErr } = await sb
    .from('profiles')
    .update({ active_jobs_today: 0 })
    .eq('role', 'assembler');
  if (resetErr) console.error('active_jobs_today reset error:', resetErr.message);

  // ── Phase 0b: Recalculate acceptance_rate for each Easer ─────────────────
  // Rate = accepted / (accepted + declined + expired) over last 30 days.
  // Excludes: 'sent' (still open), 'superseded' (Easer had no decision to make),
  //           'cancelled' (booking was cancelled before a decision).
  // Powers the 50-point acceptance_rate scoring factor in dispatch.
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: offerStats, error: statsErr } = await sb
      .from('dispatch_offers')
      .select('easer_id, offer_status')
      .gte('created_at', thirtyDaysAgo)
      .in('offer_status', ['accepted', 'declined', 'expired']);

    if (!statsErr && offerStats?.length) {
      const rates = {};
      offerStats.forEach(o => {
        if (!rates[o.easer_id]) rates[o.easer_id] = { accepted: 0, total: 0 };
        rates[o.easer_id].total++;
        if (o.offer_status === 'accepted') rates[o.easer_id].accepted++;
      });

      await Promise.allSettled(
        Object.entries(rates).map(([easerId, stats]) => {
          const rate = stats.total >= 3
            ? parseFloat((stats.accepted / stats.total * 100).toFixed(2))
            : null; // require at least 3 data points before penalising
          return sb.from('profiles').update({ acceptance_rate: rate }).eq('id', easerId);
        })
      );
      console.log(`acceptance_rate updated for ${Object.keys(rates).length} Easer(s)`);
    } else if (statsErr) {
      console.error('acceptance_rate stats query error:', statsErr.message);
    }
  } catch (arErr) {
    console.error('acceptance_rate calculation error:', arErr.message);
  }

  const promoted = { toProfessional: 0, toElite: 0 };

  // starter → professional
  const { data: starterProfiles, error: e1 } = await sb
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'assembler')
    .eq('status', 'active')
    .eq('tier', 'starter')
    .eq('identity_verified', true)
    .gte('completed_jobs', 10)
    .gte('rating', 4.5);

  if (!e1 && starterProfiles?.length) {
    const ids = starterProfiles.map(p => p.id);
    const { error: upErr } = await sb.from('profiles').update({ tier: 'professional' }).in('id', ids);
    if (!upErr) promoted.toProfessional = ids.length;
    else console.error('Tier-check starter→professional error:', upErr);
  }

  // professional → elite
  const { data: proProfiles, error: e2 } = await sb
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'assembler')
    .eq('status', 'active')
    .eq('tier', 'professional')
    .eq('identity_verified', true)
    .gte('completed_jobs', 30)
    .gte('rating', 4.8);

  if (!e2 && proProfiles?.length) {
    const ids = proProfiles.map(p => p.id);
    const { error: upErr } = await sb.from('profiles').update({ tier: 'elite' }).in('id', ids);
    if (!upErr) promoted.toElite = ids.length;
    else console.error('Tier-check professional→elite error:', upErr);
  }

  console.log('Tier-check complete:', promoted);
  return res.status(200).json({ ok: true, promoted });
}
