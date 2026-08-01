import { getSupabase } from '../_supabase.js';
import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { getEaserReadiness } from '../_easer-readiness.js';

function publicMissingItems(readiness = {}) {
  const publicItems = [];
  const missing = Array.isArray(readiness.missingItems) ? readiness.missingItems : [];
  if (missing.some(item => /application fee/i.test(item))) publicItems.push('Application payment complete');
  if (missing.some(item => /identity/i.test(item))) publicItems.push('Identity verification complete');
  if (missing.some(item => /owner approved/i.test(item))) publicItems.push('Application approved');
  if (missing.some(item => /phone/i.test(item))) publicItems.push('Phone number added');
  if (missing.some(item => /contractor agreement/i.test(item))) publicItems.push('Contractor agreement accepted');
  if (missing.some(item => /code of conduct/i.test(item))) publicItems.push('Code of Conduct accepted');
  if (missing.some(item => /availability/i.test(item))) publicItems.push('Availability enabled');
  if (missing.some(item => /stripe|payout/i.test(item))) publicItems.push('Payout setup complete');
  if (missing.some(item => /account closure/i.test(item))) publicItems.push('Account available for jobs');
  return publicItems;
}

export function toPublicEaserReadiness(readiness = {}) {
  return {
    isReady: readiness.isReady === true,
    agreementCurrent: readiness.agreementCurrent === true,
    codeOfConductAccepted: readiness.codeOfConductAccepted === true,
    missingItems: publicMissingItems(readiness),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);

  const sb = getSupabase();
  const { data: profile, error } = await sb
    .from('profiles')
    .select('id, role, status, application_status, tier, is_available, phone, identity_verified, contractor_agreement_signed_at, contractor_agreement_version, code_of_conduct_agreed_at, application_fee_paid, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, account_closure_status, stripe_connect_account_id')
    .eq('id', authenticated.user.id)
    .maybeSingle();

  if (error) {
    console.error('[easer-readiness] Profile lookup failed:', error.message || error);
    return res.status(503).json({
      error: 'Job readiness could not be verified. Please retry.',
      code: 'EASER_READINESS_LOOKUP_FAILED',
    });
  }
  if (!profile || profile.role !== 'assembler') {
    return res.status(403).json({ error: 'Easer access required' });
  }

  try {
    const readiness = await getEaserReadiness(profile, { requireAvailability: false });
    return res.status(200).json({ readiness: toPublicEaserReadiness(readiness) });
  } catch (readinessError) {
    console.error('[easer-readiness] Verification failed:', readinessError?.message || readinessError);
    return res.status(503).json({
      error: 'Job readiness could not be verified. Please retry.',
      code: 'EASER_READINESS_CHECK_FAILED',
    });
  }
}
