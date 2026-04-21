import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * GET /api/assembler/list
 * Owner-only: returns all assembler profiles with persona/tier status.
 * Query params: ?tier=pending|starter|verified|elite&search=name
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { tier, search } = req.query;

  let query = sb
    .from('profiles')
    .select('id, full_name, email, phone, city, zip, tier, identity_verified, identity_verified_at, stripe_verification_id, stripe_customer_id, payment_confirmed, services_offered, has_tools, has_transport, years_experience, rating, completed_jobs, created_at, application_status, rejected_at')
    .eq('role', 'assembler')
    .order('created_at', { ascending: false });

  if (tier && tier !== 'all') query = query.eq('tier', tier);
  if (search) query = query.ilike('full_name', `%${search}%`);

  const { data, error } = await query;

  if (error) {
    console.error('Assembler list error:', error);
    return res.status(500).json({ error: 'Failed to fetch assemblers' });
  }

  const assemblers = data || [];
  const stats = {
    total: assemblers.length,
    pending: assemblers.filter(a => a.tier === 'pending' && a.application_status !== 'rejected').length,
    starter: assemblers.filter(a => a.tier === 'starter').length,
    verified: assemblers.filter(a => a.tier === 'verified').length,
    elite: assemblers.filter(a => a.tier === 'elite').length,
    rejected: assemblers.filter(a => a.application_status === 'rejected').length,
  };

  return res.status(200).json({ assemblers, stats });
}
