import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { getSupabase } from '../_supabase.js';
import { WEEKDAYS, normalizeWorkPreferences, normalizeTravelRadius, serviceNames } from '../_easer-work-preferences.js';
import { describeEaserServiceArea } from '../_market-area.js';

/**
 * GET/POST /api/assembler/work-preferences — the services an Easer takes, the
 * hours they work (migration 110) and how far they travel from their home ZIP
 * (migration 132). Dispatch reads the same columns through
 * api/_easer-work-preferences.js and serviceAreaCheck(). Unset means every
 * service, any time, and the default travel distance.
 *
 * POST takes any of { services, availability } and { travelRadiusMiles }; a
 * body with only travelRadiusMiles leaves services and hours as they are.
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
    .select('id, role, zip, city').eq('id', userId).maybeSingle();
  if (profileError) return res.status(503).json({ error: 'Your account could not be checked. Try again.' });
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'An Easer account is required.' });

  const allServices = serviceNames();
  // Where the Easer gets jobs: their home ZIP's area and the distance they
  // travel from it. `unavailable` until migration 132 adds the column; the
  // default distance still applies to dispatch either way.
  const travelArea = (radiusRow) => ({
    ...describeEaserServiceArea({ zip: profile.zip, city: profile.city, travel_radius_miles: radiusRow?.travel_radius_miles ?? null }),
    unavailable: radiusRow === undefined,
  });
  const readRadius = async () => {
    try {
      const { data, error } = await sb.from('profiles').select('travel_radius_miles').eq('id', userId).maybeSingle();
      return error ? undefined : (data || {});
    } catch { return undefined; }
  };
  const shape = (row, radiusRow) => ({
    ok: true,
    allServices,
    weekdays: WEEKDAYS,
    services: Array.isArray(row?.work_services) && row.work_services.length ? row.work_services : null,
    availability: row?.weekly_availability || null,
    updatedAt: row?.work_preferences_updated_at || null,
    travelArea: travelArea(radiusRow),
  });

  if (req.method === 'GET') {
    const { data, error } = await sb.from('profiles')
      .select('work_services, weekly_availability, work_preferences_updated_at')
      .eq('id', userId).maybeSingle();
    const radiusRow = await readRadius();
    // Before migration 110 the columns do not exist: every service, any time.
    if (error) return res.status(200).json({ ...shape(null, radiusRow), unavailable: true });
    return res.status(200).json(shape(data, radiusRow));
  }

  const body = req.body || {};
  const hasPreferences = Object.prototype.hasOwnProperty.call(body, 'services')
    || Object.prototype.hasOwnProperty.call(body, 'availability');
  const hasRadius = Object.prototype.hasOwnProperty.call(body, 'travelRadiusMiles');
  if (!hasPreferences && !hasRadius) return res.status(400).json({ error: 'Nothing to save.' });

  let radiusValue = null;
  if (hasRadius) {
    const radius = normalizeTravelRadius(body.travelRadiusMiles);
    if (!radius.ok) return res.status(400).json({ error: radius.error });
    radiusValue = radius.value;
  }
  const checked = hasPreferences ? normalizeWorkPreferences(body, allServices) : null;
  if (checked && !checked.ok) return res.status(400).json({ error: checked.error });

  if (hasRadius) {
    const { data: savedRadius, error: radiusError } = await sb.from('profiles')
      .update({ travel_radius_miles: radiusValue })
      .eq('id', userId)
      .eq('role', 'assembler')
      .select('travel_radius_miles')
      .maybeSingle();
    if (radiusError || !savedRadius) {
      console.error('[work-preferences] travel distance save failed:', radiusError?.message || 'no row');
      return res.status(503).json({ error: 'Your travel distance could not be saved. Try again.' });
    }
  }

  if (!checked) {
    const { data: current } = await sb.from('profiles')
      .select('work_services, weekly_availability, work_preferences_updated_at')
      .eq('id', userId).maybeSingle();
    return res.status(200).json(shape(current, await readRadius()));
  }

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
  return res.status(200).json(shape(saved, await readRadius()));
}
