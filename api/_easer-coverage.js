// Which areas have an active Easer (owner, 2026-11-11). One definition, read by
// the booking page and the app before booking, by the early owner alert for an
// unaccepted booking, and by the per-hub Easer application fee.
//
// An Easer covers a ZIP when they are active, approved and not the App Review
// demo account, and their own ZIP is in the same service market (marketForZip,
// the map dispatch uses), or, where no market is set up yet, the same first
// three digits.
import { marketForZip } from './_source-of-truth.js';

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

export function sameCoverageArea(customerZip, easerZip) {
  const a = String(customerZip || '').trim().slice(0, 5);
  const b = String(easerZip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(a) || !/^\d{5}$/.test(b)) return false;
  const marketA = marketForZip(a);
  if (marketA) return marketA === marketForZip(b);
  return !marketForZip(b) && a.slice(0, 3) === b.slice(0, 3);
}

export function easersCovering(easerZips, customerZip) {
  return (easerZips || []).filter(zip => sameCoverageArea(customerZip, zip)).length;
}

// Shown before booking where no active Easer covers the ZIP. Booking stays open.
export const UNCOVERED_AREA_NOTE = 'Pros are limited near this ZIP. We confirm your pro before your visit, and you pay only when the job is done.';
