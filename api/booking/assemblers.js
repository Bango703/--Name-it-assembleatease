import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { normalizeAssemblerProfile } from '../_assembler-state.js';
import { getEaserReadiness } from '../_easer-readiness.js';

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
    .select('id, role, full_name, email, phone, city, status, application_status, tier, rating, completed_jobs, is_available, identity_verified, is_owner, contractor_agreement_signed_at, contractor_agreement_version, code_of_conduct_agreed_at, application_fee_paid, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, account_closure_status, stripe_connect_account_id')
    .eq('role', 'assembler')
    .order('tier', { ascending: false })
    .order('rating', { ascending: false, nullsFirst: false });

  if (error) {
    console.error('Load assemblers error:', error);
    return res.status(500).json({ error: 'Failed to load assemblers' });
  }

  const assemblers = [];
  let ownerEaser = null;
  for (const profile of data || []) {
    const normalized = normalizeAssemblerProfile(profile);
    const readiness = await getEaserReadiness(normalized);
    if (normalized.is_owner === true) {
      ownerEaser = {
        id: normalized.id,
        full_name: normalized.full_name,
        email: normalized.email,
        city: normalized.city,
        status: normalized.status,
        tier: normalized.tier,
        rating: normalized.rating,
        completed_jobs: normalized.completed_jobs,
        is_available: normalized.is_available,
        identity_verified: normalized.identity_verified,
        is_owner: true,
        is_job_ready: readiness.isReady === true,
        missing_items: readiness.missingItems || [],
      };
    }
    if (!readiness.isReady) continue;
    assemblers.push({
      id: normalized.id,
      full_name: normalized.full_name,
      email: normalized.email,
      city: normalized.city,
      status: normalized.status,
      tier: normalized.tier,
      rating: normalized.rating,
      completed_jobs: normalized.completed_jobs,
      is_available: normalized.is_available,
      identity_verified: normalized.identity_verified,
      is_owner: normalized.is_owner === true,
    });
  }

  return res.status(200).json({ assemblers, ownerEaser });
}
