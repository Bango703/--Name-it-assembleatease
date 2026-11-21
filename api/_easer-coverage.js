// Which areas have an active Easer (owner, 2026-11-11). One definition, read by
// the booking page and the app before booking, by the early owner alert for an
// unaccepted booking, and by the per-hub Easer application fee.
//
// An Easer covers a ZIP when they are active, approved and not the App Review
// demo account, and the ZIP is within their travel distance of their home ZIP:
// serviceAreaCheck, the same rule dispatch uses to send offers (owner,
// 2026-11-21). "Covered" before booking and "offered" after booking can no
// longer disagree.
import { serviceAreaCheck } from './_source-of-truth.js';
import { loadTravelRadii } from './_easer-work-preferences.js';

export async function activeEaserZips(sb) {
  const { data, error } = await sb
    .from('profiles')
    .select('zip, is_demo_account')
    .eq('role', 'assembler')
    .eq('status', 'active')
    .eq('application_status', 'approved');
  if (error) throw new Error(`Active Easer count failed: ${error.message || error}`);
  return (data || [])
    .filter(profile => profile.is_demo_account !== true)
    .map(profile => String(profile.zip || '').trim().slice(0, 5))
    .filter(zip => /^\d{5}$/.test(zip));
}

/**
 * Active Easers' home ZIPs with the travel distance each chose, for coverage.
 * The distance is read with its own query (loadTravelRadii), so this works
 * before migration 132; an Easer without one gets the default distance.
 * @returns {Promise<Array<{zip:string, travel_radius_miles:number|null}>>}
 */
export async function activeEaserAreas(sb) {
  const { data, error } = await sb
    .from('profiles')
    .select('id, zip, is_demo_account')
    .eq('role', 'assembler')
    .eq('status', 'active')
    .eq('application_status', 'approved');
  if (error) throw new Error(`Active Easer count failed: ${error.message || error}`);
  const rows = (data || [])
    .filter(profile => profile.is_demo_account !== true)
    .map(profile => ({ id: profile.id, zip: String(profile.zip || '').trim().slice(0, 5) }))
    .filter(row => /^\d{5}$/.test(row.zip));
  const radii = await loadTravelRadii(sb, rows.map(row => row.id));
  return rows.map(row => ({ zip: row.zip, travel_radius_miles: radii.get(row.id) ?? null }));
}

/** Does an Easer (a home ZIP string, or { zip, travel_radius_miles }) cover this customer ZIP? */
export function sameCoverageArea(customerZip, easer) {
  const area = typeof easer === 'string' || easer == null ? { zip: easer } : easer;
  return serviceAreaCheck(String(customerZip || '').trim().slice(0, 5), area).ok;
}

export function easersCovering(easers, customerZip) {
  return (easers || []).filter(easer => sameCoverageArea(customerZip, easer)).length;
}

// Shown before booking where no active Easer covers the ZIP. Booking stays open.
export const UNCOVERED_AREA_NOTE = 'Pros are limited near this ZIP. We confirm your pro before your visit, and you pay only when the job is done.';
