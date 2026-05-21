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
