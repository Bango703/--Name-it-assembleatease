import { marketForZip, SERVICE_MARKETS, TRAVEL_RADIUS_MILES, easerTravelRadiusMiles, zipLocation } from './_source-of-truth.js';
import { isTexasZip, normalizeServiceCity, normalizeServiceState, normalizeServiceZip, parseServiceLocation } from './_booking-location.js';
import { US_STATE_CODES } from './_waitlist-core.js';

// Presentation only. ZIP membership belongs exclusively to marketForZip.
const AREA_LABELS = Object.freeze({
  central_texas: { city: 'Austin', label: 'Austin / Central Texas' },
  houston: { city: 'Houston', label: 'Houston area' },
  san_antonio: { city: 'San Antonio', label: 'San Antonio area' },
  lubbock: { city: 'Lubbock', label: 'Lubbock area' },
  permian_basin: { city: 'Permian Basin', label: 'Permian Basin' },
  dallas_fort_worth: { city: 'Dallas', label: 'Dallas-Fort Worth area' },
  east_texas: { city: 'Tyler', label: 'Tyler, Longview and East Texas' },
  wichita_falls: { city: 'Wichita Falls', label: 'Wichita Falls area' },
  stephenville: { city: 'Stephenville', label: 'Stephenville and Mineral Wells area' },
  waco_killeen: { city: 'Waco', label: 'Waco, Killeen and Temple area' },
  brownwood: { city: 'Brownwood', label: 'Brownwood area' },
  san_angelo: { city: 'San Angelo', label: 'San Angelo area' },
  beaumont: { city: 'Beaumont', label: 'Beaumont and Port Arthur area' },
  brazos_valley: { city: 'Bryan', label: 'Bryan-College Station and Brazos Valley' },
  victoria: { city: 'Victoria', label: 'Victoria area' },
  corpus_christi: { city: 'Corpus Christi', label: 'Corpus Christi area' },
  rio_grande_valley: { city: 'McAllen', label: 'Rio Grande Valley' },
  southwest_texas: { city: 'Del Rio', label: 'Del Rio, Eagle Pass and Uvalde area' },
  amarillo: { city: 'Amarillo', label: 'Amarillo and Panhandle' },
  abilene: { city: 'Abilene', label: 'Abilene area' },
  el_paso: { city: 'El Paso', label: 'El Paso and Far West Texas' },
});

/** The owner- and Easer-facing name of a market, e.g. "East Texas (Tyler, Longview)". */
export function marketLabel(key) {
  if (!key) return null;
  return (AREA_LABELS[key] || { label: String(key).replace(/_/g, ' ') }).label;
}

/**
 * Where an Easer gets job offers, for the owner's Easer card and the Easer's
 * own profile: the home ZIP's area and the travel distance dispatch uses
 * (serviceAreaCheck). `located: false` means dispatch cannot place the home ZIP
 * on the map, so the Easer gets no offers until it is fixed.
 * Pass `travelRadiusMiles: undefined` when the saved distance could not be read.
 */
export function describeEaserServiceArea(profile = {}) {
  const homeZip = String(profile?.zip || '').trim().slice(0, 5) || null;
  const saved = profile?.travel_radius_miles ?? null;
  const location = zipLocation(homeZip);
  const marketKey = marketForZip(homeZip);
  return {
    homeZip,
    homeCity: profile?.city || null,
    located: Boolean(location),
    approximate: location?.precision === 'nearby_zip',
    marketKey,
    areaLabel: marketLabel(marketKey),
    radiusMiles: easerTravelRadiusMiles({ travel_radius_miles: saved }),
    isDefault: saved === null,
    options: TRAVEL_RADIUS_MILES.options,
  };
}

export function knownMarketAreas() {
  return Object.keys(SERVICE_MARKETS).map(key => {
    const presentation = AREA_LABELS[key] || { city: key, label: key.replace(/_/g, ' ') };
    return { marketKey: key, marketLabel: presentation.label, city: presentation.city,
      state: 'TX', coverageKnown: true, locationIssue: null };
  });
}

/** Read-only reporting geography, not a dispatch or eligibility decision. */
export function resolveMarketArea(input = {}) {
  const parsed = parseServiceLocation(input);
  const city = normalizeServiceCity(parsed.city);
  const state = normalizeServiceState(parsed.state);
  const zip = normalizeServiceZip(parsed.zip);
  const rawState = String(input.state || '').trim();
  const rawZip = String(input.zip || '').trim();
  let locationIssue = null;
  if (rawState && !US_STATE_CODES.has(normalizeServiceState(rawState))) locationIssue = 'State is not a recognized US state';
  else if (rawZip && !/^\d{5}(?:-\d{4})?$/.test(rawZip)) locationIssue = 'ZIP is not a valid five-digit ZIP or ZIP+4';
  else if (!city || !state || !zip) locationIssue = 'City, state, or ZIP is missing';
  else if ((state === 'TX') !== isTexasZip(zip)) locationIssue = 'State and ZIP disagree';

  const location = { city, state, zip };
  if (locationIssue) return {
    marketKey: 'location-review', marketLabel: 'Location review',
    city: 'Location review', state: '', coverageKnown: false, locationIssue, location,
  };

  const key = state === 'TX' ? marketForZip(zip) : null;
  if (key) {
    return { ...knownMarketAreas().find(area => area.marketKey === key), location };
  }
  // Every Texas ZIP has a market, so this is a non-Texas location: it stays
  // local to the recorded city/ZIP.
  return {
    marketKey: `unconfigured:${state.toLowerCase()}:${city.toLowerCase()}:${zip}`,
    marketLabel: `${city}, ${state} ${zip}`, city, state,
    coverageKnown: false, locationIssue: null, location,
  };
}
