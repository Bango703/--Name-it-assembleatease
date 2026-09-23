import { marketForZip, SERVICE_MARKETS } from './_source-of-truth.js';
import { isTexasZip, normalizeServiceCity, normalizeServiceState, normalizeServiceZip, parseServiceLocation } from './_booking-location.js';
import { US_STATE_CODES } from './_waitlist-core.js';

// Presentation only. ZIP membership belongs exclusively to marketForZip.
const AREA_LABELS = Object.freeze({
  central_texas: { city: 'Austin', label: 'Austin / Central Texas' },
  houston: { city: 'Houston', label: 'Houston area' },
  san_antonio: { city: 'San Antonio', label: 'San Antonio area' },
  lubbock: { city: 'Lubbock', label: 'Lubbock area' },
  permian_basin: { city: 'Permian Basin', label: 'Permian Basin' },
});

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
  // Unknown markets stay local to the recorded city/ZIP. The dispatch helper's
  // deliberate unknown-ZIP fail-open is not evidence of geographic coverage.
  return {
    marketKey: `unconfigured:${state.toLowerCase()}:${city.toLowerCase()}:${zip}`,
    marketLabel: `${city}, ${state} ${zip}`, city, state,
    coverageKnown: false, locationIssue: null, location,
  };
}
