import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * GET /api/booking/assemblers
 * Returns eligible assemblers (tier starter/verified/elite + persona_verified).
 * Owner-only endpoint.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();

  const { data, error } = await sb
    .from('profiles')
    .select('id, full_name, email, city, tier, rating, completed_jobs, is_available, persona_verified')
    .eq('role', 'assembler')
    .eq('persona_verified', true)
    .in('tier', ['starter', 'verified', 'elite'])
    .order('tier', { ascending: false })
    .order('rating', { ascending: false, nullsFirst: false });

  if (error) {
    console.error('Load assemblers error:', error);
    return res.status(500).json({ error: 'Failed to load assemblers' });
  }

  return res.status(200).json({ assemblers: data || [] });
}
