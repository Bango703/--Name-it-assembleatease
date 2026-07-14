import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import { normalizeAssemblerProfile } from '../_assembler-state.js';
import { getEaserReadiness } from '../_easer-readiness.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';

/**
 * GET /api/assembler/list
 * Owner-only: returns all Easer profiles using clean status/tier separation.
 * Status: pending | active | suspended | rejected
 * Tier:   starter | professional | elite (null for non-active)
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { status, tier, search } = req.query;

  let query = sb
    .from('profiles')
    .select('*')
    .eq('role', 'assembler')
    .order('created_at', { ascending: false });

  if (status && status !== 'all') query = query.eq('status', status);
  if (tier && tier !== 'all') query = query.eq('tier', tier);
  if (search) query = query.ilike('full_name', `%${search}%`);

  const { data, error } = await query;
  if (error) {
    console.error('Assembler list error:', error);
    return res.status(500).json({ error: 'Failed to fetch assemblers: ' + error.message });
  }

  const normalized = (data || []).map(profile => normalizeAssemblerProfile(sanitizeAssemblerForOwner(profile)));
  const requireConnect = isStripeConnectEnabled();
  const assemblers = await Promise.all(normalized.map(async assembler => ({
    ...assembler,
    readiness: await getEaserReadiness(assembler, { connectRequired: requireConnect }),
  })));

  const stats = {
    total:         assemblers.length,
    pending:       assemblers.filter(a => a.status === 'pending').length,
    active:        assemblers.filter(a => a.status === 'active').length,
    suspended:     assemblers.filter(a => a.status === 'suspended').length,
    rejected:      assemblers.filter(a => a.status === 'rejected').length,
    starter:       assemblers.filter(a => a.status === 'active' && a.tier === 'starter').length,
    professional:  assemblers.filter(a => a.status === 'active' && a.tier === 'professional').length,
    elite:         assemblers.filter(a => a.status === 'active' && a.tier === 'elite').length,
    dispatchEligible: assemblers.filter(a => a.readiness.isReady).length,
    connectRequired: requireConnect,
  };

  return res.status(200).json({ assemblers, stats });
}

function sanitizeAssemblerForOwner(profile = {}) {
  // Owner operations need readiness evidence, not reusable bearer secrets or
  // raw device/network fingerprints in browser memory.
  const {
    identity_resume_token,
    contractor_agreement_ip,
    contractor_agreement_user_agent,
    ...safeProfile
  } = profile;
  return {
    ...safeProfile,
    has_membership: hasEffectiveEaserMembership(profile),
  };
}
