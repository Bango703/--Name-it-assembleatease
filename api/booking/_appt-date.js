export function parseIsoCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const parsed = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) return null;
  return parsed;
}

export function chicagoTodayIso(now = new Date()) {
  const values = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return `${values.year}-${values.month}-${values.day}`;
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
export function appointmentTimestampMs(dateStr, timeStr) {
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
    timeZone: 'America/Chicago',
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
