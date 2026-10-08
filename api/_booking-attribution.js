import { CITIES, STATEWIDE_MARKETS } from '../scripts/lib/texas-cities.mjs';
import { marketForZip } from './_source-of-truth.js';

// Compatibility names only; all booking, inquiry and application normalization
// is owned by the canonical acquisition module.
export { cleanAcquisitionAttribution as cleanBookingAttribution, safeAcquisitionPath } from './_attribution.js';

const CITY_NAMES = new Map([...CITIES, ...STATEWIDE_MARKETS].map(city => [city.name.toLowerCase(), city.name]));

// Reporting labels only: never used for dispatch, eligibility, prices or payment state.
export function bookingAnalyticsContext(location = {}) {
  return {
    service_market: marketForZip(location.zip) || 'unknown',
    service_city: CITY_NAMES.get(String(location.city || '').trim().toLowerCase()) || 'unknown',
  };
}
