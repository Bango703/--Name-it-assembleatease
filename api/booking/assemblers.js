import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { ACTIVE_EASER_TIERS, normalizeAssemblerProfile } from '../_assembler-state.js';

/**
 * GET /api/booking/assemblers
 * Returns eligible assemblers (active status + tier starter/professional/elite + identity_verified).
 * Owner-only endpoint.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();

  const { data, error } = await sb
    .from('profiles')
    .select('id, full_name, email, city, status, tier, rating, completed_jobs, is_available, identity_verified')
    .eq('role', 'assembler')
    .eq('identity_verified', true)
    .order('tier', { ascending: false })
    .order('rating', { ascending: false, nullsFirst: false });

  if (error) {
    console.error('Load assemblers error:', error);
    return res.status(500).json({ error: 'Failed to load assemblers' });
  }

  const assemblers = (data || [])
    .map(normalizeAssemblerProfile)
    .filter(function(assembler) {
      return assembler.status === 'active' && ACTIVE_EASER_TIERS.includes(assembler.tier);
    });

  return res.status(200).json({ assemblers });
}
