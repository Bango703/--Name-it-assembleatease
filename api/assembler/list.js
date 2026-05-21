import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

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
    .select('id, full_name, email, phone, city, zip, status, tier, previous_tier, identity_verified, identity_verified_at, id_verification_status, stripe_identity_session_id, stripe_verification_id, stripe_customer_id, application_fee_paid, fee_waived_by_owner, has_membership, services_offered, has_tools, has_transport, years_experience, rating, review_count, completed_jobs, created_at, approved_at, rejected_at, rejection_reason, application_status, is_available, last_assigned_at')
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
  const stats = {
    total:         assemblers.length,
    pending:       assemblers.filter(a => a.status === 'pending').length,
    active:        assemblers.filter(a => a.status === 'active').length,
    suspended:     assemblers.filter(a => a.status === 'suspended').length,
    rejected:      assemblers.filter(a => a.status === 'rejected').length,
    starter:       assemblers.filter(a => a.status === 'active' && a.tier === 'starter').length,
    professional:  assemblers.filter(a => a.status === 'active' && a.tier === 'professional').length,
    elite:         assemblers.filter(a => a.status === 'active' && a.tier === 'elite').length,
    dispatchEligible: assemblers.filter(a =>
      a.status === 'active' && a.identity_verified &&
      ['starter', 'professional', 'elite'].includes(a.tier)
    ).length,
  };

  return res.status(200).json({ assemblers, stats });
}
