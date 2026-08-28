/**
 * Address → coordinates, for arrival verification.
 *
 * Uses the US Census Bureau geocoder: no API key, no account, no billing, no
 * quota worth planning around, and it is not going to introduce a pricing tier
 * next quarter. It only covers US addresses, which is the entire service area.
 *
 * NEVER THROWS. A geocode is an enrichment: if it fails, the booking is still a
 * booking and the Easer can still check in — the owner just sees "address not
 * geocoded" instead of a distance. Failing a booking over a mapping lookup would
 * be far worse than not having the number.
 */

const CENSUS_ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const TIMEOUT_MS = 6000;

/**
 * @returns {Promise<{ok:boolean, lat?:number, lng?:number, source?:string, reason?:string}>}
 */
export async function geocodeAddress(address) {
  const clean = String(address || '').trim();
  if (clean.length < 8) return { ok: false, reason: 'address_too_short' };

  const url = `${CENSUS_ENDPOINT}?address=${encodeURIComponent(clean)}`
    + '&benchmark=Public_AR_Current&format=json';

  // A hung geocode must not hold a booking request open.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };

    const data = await resp.json();
    const match = data?.result?.addressMatches?.[0];
    if (!match?.coordinates) return { ok: false, reason: 'no_match' };

    const lng = Number(match.coordinates.x);
    const lat = Number(match.coordinates.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: 'bad_coordinates' };

    return { ok: true, lat, lng, source: 'us_census' };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'error');
    console.error('[geocode] failed:', reason);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Great-circle distance in metres. Server-side arithmetic — no service, no cost,
 * no dependency. Accurate to well under a metre at the scales that matter here.
 */
export function distanceMetres(lat1, lng1, lat2, lng2) {
  // null, undefined and '' all coerce to 0 through Number(), and 0 is a VALID
  // latitude — so a missing coordinate would silently become 0°N 0°E in the Gulf
  // of Guinea and return a confident four-thousand-kilometre distance instead of
  // "unknown". Reject the absent values before coercing anything.
  const raw = [lat1, lng1, lat2, lng2];
  if (raw.some(v => v === null || v === undefined || v === '')) return null;

  const coords = raw.map(Number);
  if (coords.some(v => !Number.isFinite(v))) return null;
  const [aLat, aLng, bLat, bLng] = coords;

  // Anything outside the real coordinate space is bad data, not a far-away place.
  if (Math.abs(aLat) > 90 || Math.abs(bLat) > 90) return null;
  if (Math.abs(aLng) > 180 || Math.abs(bLng) > 180) return null;

  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * How the owner should read a check-in.
 *
 * Deliberately NOT a pass/fail. GPS fails indoors, in stairwells, in garages and
 * basements, and behind a bad signal — the places furniture actually gets
 * assembled. A verdict would punish an honest Easer for a dead satellite fix, so
 * this describes what is known and lets the owner judge.
 *
 * accuracy is weighed rather than ignored: a 200m "match" reported by a fix that
 * is itself accurate to 3km proves nothing, and treating it as confirmation is
 * how a verification feature starts lying.
 */
export const ARRIVAL_CONFIRMED_M = 150;   // comfortably covers a large property
export const ARRIVAL_NEARBY_M = 500;      // same block; a plausible parking spot

export function describeArrival({ distanceM, accuracyM } = {}) {
  if (distanceM == null) {
    return { state: 'unknown', label: 'Location not shared', detail: null };
  }
  const acc = Number.isFinite(Number(accuracyM)) ? Math.round(Number(accuracyM)) : null;

  // The fix is too vague to tell us anything, whatever the distance says.
  if (acc != null && acc > ARRIVAL_NEARBY_M) {
    return {
      state: 'imprecise',
      label: 'Location too imprecise to confirm',
      detail: `phone reported ±${acc}m`,
    };
  }
  if (distanceM <= ARRIVAL_CONFIRMED_M) {
    return { state: 'confirmed', label: 'At the address', detail: `${distanceM}m away${acc != null ? ` (±${acc}m)` : ''}` };
  }
  if (distanceM <= ARRIVAL_NEARBY_M) {
    return { state: 'nearby', label: 'Near the address', detail: `${distanceM}m away${acc != null ? ` (±${acc}m)` : ''}` };
  }
  const km = distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)}km` : `${distanceM}m`;
  return { state: 'far', label: 'Not at the address', detail: `${km} away${acc != null ? ` (±${acc}m)` : ''}` };
}

/** May we record this Easer's location? Consent is a recorded fact, not an assumption. */
export function locationConsentOk(profile = {}) {
  if (profile.location_declined_at) return false;
  return Boolean(profile.location_consent_at);
}
