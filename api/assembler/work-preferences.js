import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { getSupabase } from '../_supabase.js';
import { WEEKDAYS, normalizeWorkPreferences, serviceNames } from '../_easer-work-preferences.js';

/**
 * GET/POST /api/assembler/work-preferences — the services an Easer takes and
 * the hours they work (migration 110). Dispatch reads the same columns through
 * api/_easer-work-preferences.js. Unset means every service, any time.
 */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);
  const userId = authenticated.user.id;

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id, role').eq('id', userId).maybeSingle();
  if (profileError) return res.status(503).json({ error: 'Your account could not be checked. Try again.' });
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'An Easer account is required.' });

  const allServices = serviceNames();
  const shape = (row) => ({
    ok: true,
    allServices,
    weekdays: WEEKDAYS,
    services: Array.isArray(row?.work_services) && row.work_services.length ? row.work_services : null,
    availability: row?.weekly_availability || null,
    updatedAt: row?.work_preferences_updated_at || null,
  });

  if (req.method === 'GET') {
    const { data, error } = await sb.from('profiles')
      .select('work_services, weekly_availability, work_preferences_updated_at')
      .eq('id', userId).maybeSingle();
    // Before migration 110 the columns do not exist: every service, any time.
    if (error) return res.status(200).json({ ...shape(null), unavailable: true });
    return res.status(200).json(shape(data));
  }

  const checked = normalizeWorkPreferences(req.body || {}, allServices);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  const { data: saved, error: saveError } = await sb.from('profiles')
    .update({
      work_services: checked.value.services,
      weekly_availability: checked.value.availability,
      work_preferences_updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .eq('role', 'assembler')
    .select('work_services, weekly_availability, work_preferences_updated_at')
    .maybeSingle();
  if (saveError || !saved) {
    console.error('[work-preferences] save failed:', saveError?.message || 'no row');
    return res.status(503).json({ error: 'Your work preferences could not be saved. Try again.' });
  }
  return res.status(200).json(shape(saved));
}
