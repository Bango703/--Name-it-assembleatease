import { getSupabase } from '../_supabase.js';
import {
  authenticateBearerUser,
  respondWithEaserAccessError,
} from '../_easer-access.js';

const ALLOWED_PAYOUT_PREFERENCES = new Set(['ach', 'zelle', 'paypal', 'check']);

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, role, payout_method_preference')
    .eq('id', authenticated.user.id)
    .maybeSingle();

  if (profileError) {
    console.error('[payout-preference] Profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({
      error: 'Payout preference could not be loaded. Please retry.',
      code: 'PAYOUT_PREFERENCE_LOOKUP_FAILED',
    });
  }
  if (!profile || profile.role !== 'assembler') {
    return res.status(403).json({ error: 'Easer access required' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      preference: profile.payout_method_preference || null,
      allowed: [...ALLOWED_PAYOUT_PREFERENCES],
    });
  }

  const preference = String(req.body?.preference || '').trim().toLowerCase();
  if (!ALLOWED_PAYOUT_PREFERENCES.has(preference)) {
    return res.status(400).json({
      error: 'Choose ACH, Zelle, PayPal, or check.',
      code: 'PAYOUT_PREFERENCE_INVALID',
    });
  }

  const { data: updated, error: updateError } = await sb
    .from('profiles')
    .update({ payout_method_preference: preference })
    .eq('id', authenticated.user.id)
    .eq('role', 'assembler')
    .select('payout_method_preference')
    .maybeSingle();

  if (updateError) {
    console.error('[payout-preference] Update failed:', updateError.message || updateError);
    return res.status(503).json({
      error: 'Payout preference could not be saved. Please retry.',
      code: 'PAYOUT_PREFERENCE_SAVE_FAILED',
    });
  }
  if (!updated) {
    return res.status(409).json({
      error: 'Payout preference was not saved. Refresh and try again.',
      code: 'PAYOUT_PREFERENCE_NOT_SAVED',
    });
  }

  return res.status(200).json({
    ok: true,
    preference: updated.payout_method_preference,
  });
}
