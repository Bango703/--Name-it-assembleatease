export function parseIsoCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const parsed = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) return null;
  return parsed;
}

export function localCalendarDate(now = new Date(), timeZone = 'America/Chicago') {
  const values = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return `${values.year}-${values.month}-${values.day}`;
}

export function chicagoTodayIso(now = new Date()) {
  return localCalendarDate(now, 'America/Chicago');
}

// Existing financial callers keep their Chicago default. Notifications honor
// an explicit job timezone and the El Paso location evidence when present.
export function appointmentTimeZone(booking = {}) {
  const explicit = booking.service_timezone || booking.time_zone || booking.timezone;
  if (['America/Chicago', 'America/Denver'].includes(explicit)) return explicit;
  const zip = String(booking.service_zip || booking.zip || booking.zip_code || '').trim();
  const city = String(booking.service_city || booking.city || '').trim().toLowerCase();
  if (/^799\d{2}$/.test(zip) || city === 'el paso' || /\bel paso\s*,?\s*(?:tx|texas)\b/i.test(booking.address || '')) return 'America/Denver';
  return 'America/Chicago';
}

export function notificationAppointmentTimestampMs(booking = {}) {
  if (!booking.time) return null;
  const fullTime = String(booking.time).replace(/(?<![\d:])(\b\d{1,2})\s*(AM|PM)\b/gi, '$1:00 $2');
  return appointmentTimestampMs(booking.date, fullTime, appointmentTimeZone(booking));
}

/**
 * Compute the UTC timestamp (ms) for a booking appointment in America/Chicago time.
 * Handles CDT (UTC-5, mid-Mar → early Nov) and CST (UTC-6, rest of year) automatically
 * via Intl.DateTimeFormat — no manual DST logic required.
 *
 * @param {string} dateStr — booking.date: 'YYYY-MM-DD'
 * @param {string} timeStr — booking.time: e.g. '9:00 AM - 11:00 AM' or '9:00 AM'
 * @returns {number|null}  — UTC ms timestamp, or null if input is unparseable
 */
export function appointmentTimestampMs(dateStr, timeStr, timeZone = 'America/Chicago') {
  if (!parseIsoCalendarDate(dateStr)) return null;

  // ── Parse appointment hour/minute ──────────────────────────────────────────
  let h = 12, m = 0; // default noon local — conservative, avoids edge-case misfire
  const slotStart = (timeStr || '').split(/[-–—]/)[0].trim();
  const match = slotStart.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (match) {
    h = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    const mer = match[3].toUpperCase();
    if (mer === 'PM' && h !== 12) h += 12;
    if (mer === 'AM' && h === 12) h = 0;
  } else if (slotStart) {
    // Time field present but unrecognised — log and return null so callers
    // default to no-fee (conservative, avoids erroneous charge).
    console.warn('appointmentTimestampMs: unrecognised time format:', timeStr);
    return null;
  }
  // Empty/null timeStr → noon default (see above)

  // ── Determine America/Chicago UTC offset for this specific date ────────────
  // Probe at noon UTC: safely lands on the correct calendar date for any standard
  // timezone offset (avoids date-boundary issues at extreme offsets).
  const probe = new Date(dateStr + 'T12:00:00Z');
  const fmt = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(probe).map(p => [p.type, p.value]));

  // chicagoLocalMs: probe's Chicago clock reading, interpreted as a UTC value.
  // CDT: probe=12:00 UTC → Chicago shows 07:00 → chicagoLocalMs = 07:00 UTC epoch
  // CST: probe=12:00 UTC → Chicago shows 06:00 → chicagoLocalMs = 06:00 UTC epoch
  const chicagoLocalMs = Date.UTC(
    parseInt(parts.year,   10),
    parseInt(parts.month,  10) - 1,
    parseInt(parts.day,    10),
    parseInt(parts.hour,   10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10),
  );

  // offsetMs: how many ms Chicago is behind UTC (positive for west-of-UTC zones).
  // CDT: 12:00 UTC − 07:00 local = +5 h = 18 000 000 ms
  // CST: 12:00 UTC − 06:00 local = +6 h = 21 600 000 ms
  const offsetMs = probe.getTime() - chicagoLocalMs;

  // ── Build the appointment's UTC timestamp ──────────────────────────────────
  // Treat h:m as Chicago local time on dateStr, then add offsetMs to get UTC.
  // e.g. 9:00 AM CDT -> Date.UTC(..., 9, 0) + 18 000 000 = 14:00 UTC
  // e.g. 9:00 AM CST -> Date.UTC(..., 9, 0) + 21 600 000 = 15:00 UTC
  return Date.UTC(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(5, 7), 10) - 1,
    parseInt(dateStr.slice(8, 10), 10),
    h, m, 0, 0,
  ) + offsetMs;
}

// Appointment dates are stored as calendar dates ('2026-09-24') and were being
// printed straight into customer and Easer emails, so a booking confirmation
// read "Date 2026-09-24" -- a database value, in a message meant to reassure
// someone that a stranger is coming to their home.
//
// One formatter, so no email invents its own. Parsed at noon UTC like every
// other calendar date here, which keeps the weekday correct regardless of the
// reader's timezone. Returns the raw input unchanged if it cannot be parsed:
// a malformed date should look odd, never silently become a different day.
// The same date sized for a text message: "Thu, Sep 24". Every SMS template
// has to fit one 160-character segment, and the long form is 18 longer.
export function formatAppointmentDateShort(dateStr) {
  const parsed = parseIsoCalendarDate(dateStr);
  if (!parsed) return String(dateStr || '');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short', month: 'short', day: 'numeric',
  }).format(parsed);
}

// A booked slot sized for a text: "10:00 AM – 12:00 PM" becomes "10 AM-12 PM".
// Minutes that are not :00 are kept, and nothing is invented for an empty slot.
export function formatSlotShort(timeStr) {
  const raw = String(timeStr || '').trim();
  if (!raw) return '';
  return raw
    .replace(/:00(?=\s*[AP]M)/gi, '')
    .replace(/\s*[\u2012\u2013\u2014\u2212-]\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatAppointmentDate(dateStr) {
  const parsed = parseIsoCalendarDate(dateStr);
  if (!parsed) return String(dateStr || '');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(parsed);
}
