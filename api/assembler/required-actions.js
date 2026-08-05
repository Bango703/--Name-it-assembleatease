import { getSupabase } from '../_supabase.js';
import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { getEaserRequiredActions } from '../_announcements.js';

// Returns the Easer's active required actions (e.g. "Set up your payouts") for
// the in-app banner. Reusable: whatever announcements target this Easer show up.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const authed = await authenticateBearerUser(req);
  if (!authed.ok) return respondWithEaserAccessError(res, authed);

  const sb = getSupabase();
  const { data: profile, error } = await sb
    .from('profiles')
    .select('id, role, status, application_status, stripe_connect_payouts_enabled')
    .eq('id', authed.user.id)
    .maybeSingle();

  if (error) {
    console.error('[required-actions] profile lookup failed:', error.message || error);
    return res.status(200).json({ actions: [] }); // fail soft — never block the app
  }
  if (!profile || profile.role !== 'assembler') {
    return res.status(403).json({ error: 'Easer access required' });
  }

  try {
    const actions = await getEaserRequiredActions(sb, profile);
    return res.status(200).json({ actions });
  } catch (e) {
    console.error('[required-actions] engine error:', e.message || e);
    return res.status(200).json({ actions: [] });
  }
}
