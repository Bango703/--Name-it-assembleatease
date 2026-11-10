import { createHash } from 'node:crypto';
import { normalizeUsPhone } from './_phone.js';
import { BOOKING_STATUS, ACTIVE_BOOKING_STATUSES } from './_source-of-truth.js';
import { evaluateCustomerContactRelease } from './booking/_customer-contact-release.js';

/**
 * Private lines (owner, 2026-11-08): a customer and the Easer on her job call
 * each other through a small pool of AssembleAtEase numbers, and neither ever
 * sees the other's real number.
 *
 * - The pool is separate from the business number. Anyone who calls the
 *   business number reaches the business line (rep, then the AI receptionist);
 *   it never connects them to each other. The private-line webhook refuses any
 *   call that was not placed to a pool number.
 * - A line is open from the moment the customer's contact would be released
 *   today (24 hours before the job, or at once when the Easer is on the way;
 *   api/booking/_customer-contact-release.js), until 24 hours after the job is
 *   completed. Cancelled or declined closes it.
 * - A customer reaches the lead Easer (booking_crew role 'lead'), else the
 *   assigned Easer. An Easer reaches the customer.
 * - A caller with more than one open line hears a short menu. With nothing
 *   open, the call goes to the business line.
 * - The person being called hears who it is from and presses 1 to connect, so
 *   no call is ever joined to a voicemail greeting.
 *
 * Off until PRIVATE_CALLING_ENABLED=true and the pool is configured.
 * Recording (with the announcement) only when PRIVATE_CALL_RECORDING_ENABLED=true.
 */

export const CLOSE_AFTER_COMPLETION_HOURS = 24;

export function privateLineConfig(env = process.env) {
  const apiKey = String(env.TELNYX_API_KEY || '').trim();
  const appId = String(env.TELNYX_PRIVATE_LINE_APP_ID || '').trim();
  const numbers = String(env.TELNYX_PRIVATE_LINE_NUMBERS || '')
    .split(',').map((n) => normalizeUsPhone(n.trim())).filter(Boolean);
  const businessNumber = normalizeUsPhone(env.TELNYX_FROM_NUMBER);
  const missing = [];
  if (!apiKey) missing.push('TELNYX_API_KEY');
  if (!appId) missing.push('TELNYX_PRIVATE_LINE_APP_ID');
  if (!numbers.length) missing.push('TELNYX_PRIVATE_LINE_NUMBERS');
  if (!businessNumber) missing.push('TELNYX_FROM_NUMBER');
  const switchedOn = String(env.PRIVATE_CALLING_ENABLED || '').trim() === 'true';
  return {
    apiKey, appId, numbers, businessNumber,
    enabled: switchedOn && missing.length === 0,
    recording: String(env.PRIVATE_CALL_RECORDING_ENABLED || '').trim() === 'true',
    missing,
  };
}

/** Only pool numbers are private lines; the business number never is. */
export function isPoolNumber(cfg, number) {
  const n = normalizeUsPhone(number);
  return Boolean(n) && n !== cfg.businessNumber && cfg.numbers.includes(n);
}

/** The pool number a booking's calls show, stable for that booking. */
export function lineNumberFor(cfg, bookingId) {
  if (!cfg.numbers.length) return null;
  const digest = createHash('sha256').update(String(bookingId || '')).digest();
  return cfg.numbers[digest.readUInt32BE(0) % cfg.numbers.length];
}

/** Is this booking's private line open right now? */
export function privateLineOpen(booking = {}, nowMs = Date.now()) {
  if (!booking.assembler_id || !booking.assembler_accepted_at) return false;
  if ([BOOKING_STATUS.CANCELLED, BOOKING_STATUS.DECLINED].includes(booking.status)) return false;
  if (booking.status === BOOKING_STATUS.COMPLETED && !booking.return_visit_required) {
    const done = Date.parse(booking.completed_at || '');
    return Number.isFinite(done) && nowMs - done <= CLOSE_AFTER_COMPLETION_HOURS * 3600000;
  }
  return evaluateCustomerContactRelease(booking, nowMs).released === true;
}

const SESSION_FIELDS = 'id, ref, service, status, date, time, customer_phone, customer_name, sms_consent_at, sms_opted_out_at, assembler_id, assembler_name, assembler_accepted_at, completed_at, return_visit_required, return_visit_date, return_visit_time';
const LOOKUP_STATUSES = [...ACTIVE_BOOKING_STATUSES, BOOKING_STATUS.COMPLETED];

/** The Easer a customer's call reaches: the crew lead, else the assigned Easer. */
export async function leadEaserId(sb, booking) {
  try {
    const { data } = await sb.from('booking_crew').select('easer_id').eq('booking_id', booking.id).eq('role', 'lead').limit(1);
    if (data?.[0]?.easer_id) return data[0].easer_id;
  } catch { /* fall back to the assigned Easer */ }
  return booking.assembler_id || null;
}

async function easerPhone(sb, easerId) {
  if (!easerId) return null;
  const { data } = await sb.from('profiles').select('phone').eq('id', easerId).eq('role', 'assembler').maybeSingle();
  return normalizeUsPhone(data?.phone);
}

/**
 * Every open private line this caller is on, with who the call should reach.
 * Caller ID is a routing hint, never an identity claim: the destination is
 * always a number this platform already holds, and nobody learns it.
 */
export async function openLinesForCaller(sb, callerNumber, nowMs = Date.now()) {
  const caller = normalizeUsPhone(callerNumber);
  if (!caller) return [];
  const lines = [];

  const { data: asCustomer } = await sb.from('bookings').select(SESSION_FIELDS)
    .eq('customer_phone', caller).in('status', LOOKUP_STATUSES)
    .not('assembler_accepted_at', 'is', null).order('date', { ascending: true }).limit(10);
  for (const booking of asCustomer || []) {
    if (!privateLineOpen(booking, nowMs)) continue;
    const destination = await easerPhone(sb, await leadEaserId(sb, booking));
    if (destination && destination !== caller) lines.push({ booking, callerType: 'customer', destination });
  }

  const { data: easers } = await sb.from('profiles').select('id, phone').eq('role', 'assembler');
  const easer = (easers || []).find((row) => normalizeUsPhone(row.phone) === caller);
  if (easer) {
    const { data: assigned } = await sb.from('bookings').select(SESSION_FIELDS)
      .eq('assembler_id', easer.id).in('status', LOOKUP_STATUSES)
      .not('assembler_accepted_at', 'is', null).order('date', { ascending: true }).limit(10);
    // Jobs where this Easer is the crew lead without being the assigned Easer.
    let led = [];
    try {
      const { data: crewRows } = await sb.from('booking_crew').select('booking_id').eq('easer_id', easer.id).eq('role', 'lead').limit(10);
      const ids = (crewRows || []).map((r) => r.booking_id).filter((id) => !(assigned || []).some((b) => b.id === id));
      if (ids.length) {
        const { data } = await sb.from('bookings').select(SESSION_FIELDS).in('id', ids).in('status', LOOKUP_STATUSES)
          .not('assembler_accepted_at', 'is', null).limit(10);
        led = data || [];
      }
    } catch { led = []; }
    for (const booking of [...(assigned || []), ...led]) {
      if (!privateLineOpen(booking, nowMs)) continue;
      if ((await leadEaserId(sb, booking)) !== easer.id) continue;
      const destination = normalizeUsPhone(booking.customer_phone);
      if (destination && destination !== caller) lines.push({ booking, callerType: 'easer', destination });
    }
  }
  return lines;
}

// ── What people hear ─────────────────────────────────────────────────────────
// The recording sentence is said only when recording is on, and always before
// anyone is connected (both callers hear it).
export function recordingSentence(cfg) {
  return cfg.recording ? ' This call is recorded and transcribed for quality and assurance.' : '';
}
export function callerGreeting(cfg) {
  return `Connecting your AssembleAtEase call.${recordingSentence(cfg)}`;
}
export function calleePrompt(cfg, callerType) {
  const who = callerType === 'customer' ? 'your AssembleAtEase customer' : 'your AssembleAtEase pro';
  return `This is a call from ${who}.${recordingSentence(cfg)} Press 1 to connect.`;
}
export const NO_LINE_MESSAGE = 'This number is for active AssembleAtEase jobs. Connecting you to AssembleAtEase.';
export const NO_ANSWER_MESSAGE = 'They could not take the call right now. We have let them know to call you back. Goodbye.';

function spokenDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? 'your job' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
export function menuPrompt(lines) {
  return lines.slice(0, 5).map((line, i) => {
    const start = String(line.booking.time || '').split(/[-–—]/)[0].trim();
    return `For your job on ${spokenDay(line.booking.date)}${start ? ` at ${start}` : ''}, press ${i + 1}.`;
  }).join(' ');
}

/** client_state: base64 JSON, handed back untouched by Telnyx on every event. */
export function encodeState(state) {
  return Buffer.from(JSON.stringify({ v: 1, flow: 'private_line', ...state })).toString('base64');
}
export function decodeState(encoded) {
  try {
    const parsed = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
    return parsed && parsed.v === 1 && parsed.flow === 'private_line' ? parsed : null;
  } catch {
    return null;
  }
}
