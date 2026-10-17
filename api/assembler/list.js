import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';

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

  const assemblers = data || [];
  const requireConnect = isStripeConnectEnabled();

  // Normalise: if DB hasn't been migrated yet (no status column), derive status from tier
  assemblers.forEach(a => {
    if (!a.status) {
      if (a.application_status === 'rejected' || a.tier === 'rejected') a.status = 'rejected';
      else if (a.tier === 'suspended') a.status = 'suspended';
      else if (a.tier === 'pending' || !a.tier) a.status = 'pending';
      else a.status = 'active';
    }
    // Map old 'verified' tier label to 'professional'
    if (a.tier === 'verified') a.tier = 'professional';
  });

  const stats = {
    total:         assemblers.length,
    pending:       assemblers.filter(a => a.status === 'pending').length,
    active:        assemblers.filter(a => a.status === 'active').length,
    suspended:     assemblers.filter(a => a.status === 'suspended').length,
    rejected:      assemblers.filter(a => a.status === 'rejected').length,
    starter:       assemblers.filter(a => a.status === 'active' && a.tier === 'starter').length,
    professional:  assemblers.filter(a => a.status === 'active' && a.tier === 'professional').length,
    elite:         assemblers.filter(a => a.status === 'active' && a.tier === 'elite').length,
    dispatchEligible: assemblers.filter(a => {
      if (!(a.status === 'active' && a.identity_verified && ['starter', 'professional', 'elite'].includes(a.tier))) {
        return false;
      }
      if (!requireConnect) return true;
      return !!(a.stripe_connect_onboarding_complete && a.stripe_connect_charges_enabled && a.stripe_connect_payouts_enabled);
    }).length,
    connectRequired: requireConnect,
  };

  return res.status(200).json({ assemblers, stats });
}
