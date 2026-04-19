import { getSupabase } from '../_supabase.js';

/**
 * GET /api/cron/tier-check
 * Auto-promotes assembler tiers based on performance metrics.
 *
 * starter → verified: 10+ completed_jobs AND 4.5+ rating
 * verified → elite: 30+ completed_jobs AND 4.8+ rating
 *
 * pending → starter requires owner approval + Persona verification (not automated here).
 * Runs daily at 7 AM UTC.
 */
export default async function handler(req, res) {
  // Verify cron secret
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  let promoted = { toVerified: 0, toElite: 0 };

  // Promote starter → verified
  const { data: starterProfiles, error: e1 } = await sb
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'assembler')
    .eq('tier', 'starter')
    .eq('identity_verified', true)
    .gte('completed_jobs', 10)
    .gte('rating', 4.5);

  if (!e1 && starterProfiles?.length) {
    const ids = starterProfiles.map(p => p.id);
    const { error: upErr } = await sb
      .from('profiles')
      .update({ tier: 'verified' })
      .in('id', ids);

    if (!upErr) promoted.toVerified = ids.length;
    else console.error('Tier-check: starter→verified error', upErr);
  }

  // Promote verified → elite
  const { data: verifiedProfiles, error: e2 } = await sb
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'assembler')
    .eq('tier', 'verified')
    .eq('identity_verified', true)
    .gte('completed_jobs', 30)
    .gte('rating', 4.8);

  if (!e2 && verifiedProfiles?.length) {
    const ids = verifiedProfiles.map(p => p.id);
    const { error: upErr } = await sb
      .from('profiles')
      .update({ tier: 'elite' })
      .in('id', ids);

    if (!upErr) promoted.toElite = ids.length;
    else console.error('Tier-check: verified→elite error', upErr);
  }

  console.log('Tier-check complete:', promoted);
  return res.status(200).json({ ok: true, promoted });
}
