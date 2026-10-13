import { getBookingCatalog } from './_pricing.js';

/**
 * THE rule for which jobs an Easer takes: the services they do and the hours
 * they work (migration 110). Both are optional; an Easer who has set neither
 * takes everything, exactly as before. Dispatch reads easerTakesBooking(); the
 * Account screen and the website profile save through normalizeWorkPreferences().
 */

export const WEEKDAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/** The service names customers book, from the one catalog. */
export function serviceNames() {
  // Fails open: if the catalog cannot be read, no service filter applies, so
  // dispatch never stops over this.
  try {
    return Object.keys(getBookingCatalog()?.subcategories || {});
  } catch (error) {
    console.error('[work-preferences] catalog unavailable:', error?.message || error);
    return [];
  }
}

function minutes(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Validates what an Easer submits. Returns { ok, value } or { ok:false, error }.
 * services: array of catalog service names, or null for all.
 * availability: { mon: [{ start: '08:00', end: '18:00' }], ... } or null for any time.
 */
export function normalizeWorkPreferences({ services, availability } = {}, known = serviceNames()) {
  let cleanServices = null;
  if (services !== null && services !== undefined) {
    if (!Array.isArray(services)) return { ok: false, error: 'Choose the services you take.' };
    const knownSet = new Set(known);
    cleanServices = [...new Set(services.map(s => String(s || '').trim()).filter(Boolean))];
    const unknown = cleanServices.filter(s => !knownSet.has(s));
    if (unknown.length) return { ok: false, error: `Unknown service: ${unknown[0]}` };
    if (!cleanServices.length) return { ok: false, error: 'Choose at least one service.' };
    if (cleanServices.length === known.length) cleanServices = null; // every service is "all"
  }

  let cleanAvailability = null;
  if (availability !== null && availability !== undefined) {
    if (typeof availability !== 'object' || Array.isArray(availability)) return { ok: false, error: 'Set your hours for each day.' };
    cleanAvailability = {};
    let anyDay = false;
    for (const day of WEEKDAYS) {
      const windows = availability[day];
      if (windows === undefined || windows === null) { cleanAvailability[day] = []; continue; }
      if (!Array.isArray(windows) || windows.length > 3) return { ok: false, error: 'Up to 3 time ranges a day.' };
      cleanAvailability[day] = [];
      for (const w of windows) {
        const start = minutes(w?.start);
        const end = minutes(w?.end);
        if (start === null || end === null) return { ok: false, error: 'Times use 24-hour HH:MM.' };
        if (end <= start) return { ok: false, error: 'Each range must end after it starts.' };
        cleanAvailability[day].push({ start: w.start, end: w.end });
        anyDay = true;
      }
    }
    if (!anyDay) return { ok: false, error: 'Set hours for at least one day.' };
  }
  return { ok: true, value: { services: cleanServices, availability: cleanAvailability } };
}

/** "Furniture Assembly" or "Furniture Assembly, Mounting & Hanging" as names. */
export function bookingServiceNames(booking = {}, known = serviceNames()) {
  const text = String(booking?.service || '');
  return known.filter(name => text.includes(name));
}

/** Start of the appointment window in minutes after midnight, or null. */
export function slotStartMinutes(timeStr) {
  const start = String(timeStr || '').split(/[-–—]/)[0].trim();
  const match = start.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return null;
  let h = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(match[2] || 0);
}

function weekdayOf(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!match) return null;
  return WEEKDAYS[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
}

/**
 * Does this Easer take this booking? Fails open on anything unknown (no
 * preferences, an unrecognised service, a time we cannot read), so a missing
 * preference never strands a job.
 */
export function easerTakesBooking(prefs, booking, known = serviceNames()) {
  if (!prefs) return { ok: true };
  const services = Array.isArray(prefs.work_services) ? prefs.work_services : null;
  if (services && services.length) {
    const wanted = bookingServiceNames(booking, known);
    if (wanted.length && !wanted.some(s => services.includes(s))) return { ok: false, reason: 'service' };
  }
  const availability = prefs.weekly_availability;
  if (availability && typeof availability === 'object') {
    const day = weekdayOf(booking?.date);
    const start = slotStartMinutes(booking?.time);
    if (day && start !== null) {
      const windows = Array.isArray(availability[day]) ? availability[day] : [];
      const fits = windows.some(w => {
        const from = minutes(w?.start);
        const to = minutes(w?.end);
        return from !== null && to !== null && start >= from && start < to;
      });
      if (!fits) return { ok: false, reason: 'hours' };
    }
  }
  return { ok: true };
}

/**
 * Work preferences for a set of Easers, read with their own query so dispatch
 * keeps working before migration 110 is applied (empty map = no filtering).
 */
export async function loadWorkPreferences(sb, easerIds) {
  const ids = [...new Set((easerIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    const { data, error } = await sb.from('profiles')
      .select('id, work_services, weekly_availability')
      .in('id', ids);
    if (error) return new Map();
    return new Map((data || []).map(row => [row.id, row]));
  } catch {
    return new Map();
  }
}
