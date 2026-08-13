import { getSupabase } from '../_supabase.js';
import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';

// GET /api/assembler/tier-status — the Easer's own tier + live progress toward the
// next tier. Powers the "Pro Path" progress meter in the Easer app. Read-only,
// self only. See business-artifacts/easer-tier-program.md.

const TIER_ORDER = ['starter', 'professional', 'elite'];
const TIER_LABEL = { starter: 'Starter Pro', professional: 'Professional', elite: 'Elite Pro' };
const NEXT_GATE = {
  starter:      { tier: 'professional', jobs: 10, rating: 4.5, acceptance: 80, completion: 90 },
  professional: { tier: 'elite',        jobs: 30, rating: 4.8, acceptance: 85, completion: 95 },
};
const TIER_PERKS = {
  professional: ['Higher priority on offers', 'First look at same-day jobs', 'Professional badge to customers'],
  elite:        ['Top priority — best jobs first', 'First dibs on same-day jobs', 'Elite Pro ⭐ badge to customers', 'Priority support + quarterly owner call'],
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const auth = await authenticateBearerUser(req);
  if (!auth.ok) return respondWithEaserAccessError(res, auth);

  const sb = getSupabase();
  const { data: p, error } = await sb
    .from('profiles')
    .select('role, tier, completed_jobs, rating, acceptance_rate, completion_rate')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (error || !p || p.role !== 'assembler') return res.status(403).json({ error: 'Easer access required' });

  const tier = TIER_ORDER.includes(p.tier) ? p.tier : 'starter';
  const jobs = Number(p.completed_jobs || 0);
  const rating = p.rating != null ? Number(p.rating) : null;
  const acceptance = p.acceptance_rate != null ? Number(p.acceptance_rate) : null;
  // null completion = no accepted-job failures yet = passes (matches the engine).
  const completion = p.completion_rate != null ? Number(p.completion_rate) : null;
  const gate = NEXT_GATE[tier] || null;

  let next = null;
  if (gate) {
    next = {
      tier: gate.tier,
      tierLabel: TIER_LABEL[gate.tier],
      jobsHave: jobs,
      jobsNeed: gate.jobs,
      jobsRemaining: Math.max(0, gate.jobs - jobs),
      jobsPct: Math.min(100, Math.round((jobs / gate.jobs) * 100)),
      ratingNeed: gate.rating,
      ratingMet: rating != null && rating >= gate.rating,
      acceptanceNeed: gate.acceptance,
      acceptanceMet: acceptance != null && acceptance >= gate.acceptance,
      completionNeed: gate.completion,
      completionMet: completion == null || completion >= gate.completion,
      perks: TIER_PERKS[gate.tier] || [],
    };
  }

  return res.status(200).json({
    tier,
    tierLabel: TIER_LABEL[tier],
    isTopTier: tier === 'elite',
    completedJobs: jobs,
    rating,
    acceptanceRate: acceptance,
    completionRate: completion,
    perks: TIER_PERKS[tier] || [],
    next,
  });
}
