/**
 * _owner-call-targets.js — who the owner may call through the business line,
 * and where each number is read from.
 *
 * The browser names a record (a booking, a case, an Easer, a partner). The
 * number is always read here, from that record. A phone number is never taken
 * from the request: an owner password is not authority to dial an arbitrary
 * number through the business line.
 *
 * Owner, 2026-10-16: a caller to the AI line had only a case, no booking, so
 * the only way to call her back was the owner's personal phone.
 */

export const CALL_TARGET_TYPES = Object.freeze(['booking', 'booking_easer', 'case', 'easer', 'partner']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read { type, id } from the request body. `bookingId` alone still means the booking's customer. */
export function parseCallTarget(body = {}) {
  const legacyBookingId = String(body?.bookingId || '').trim();
  const type = String(body?.type || (legacyBookingId ? 'booking' : '')).trim();
  const id = String(body?.id || legacyBookingId || '').trim();
  if (!CALL_TARGET_TYPES.includes(type)) return { ok: false, error: 'Choose who to call.' };
  if (!UUID.test(id)) return { ok: false, error: 'That record could not be found.' };
  return { ok: true, type, id };
}

async function single(query) {
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function easerProfile(sb, id) {
  return single(sb.from('profiles').select('id, full_name, phone, role').eq('id', id).eq('role', 'assembler'));
}

/**
 * The number and label for a call target, or { found: false }.
 * `ref` and `bookingId` ride along for the call log only.
 */
export async function resolveCallTarget(sb, { type, id }) {
  if (type === 'booking') {
    const b = await single(sb.from('bookings').select('id, ref, customer_name, customer_phone').eq('id', id));
    if (!b) return { found: false };
    return { found: true, phone: b.customer_phone, name: b.customer_name || 'the customer', ref: b.ref, bookingId: b.id };
  }
  if (type === 'booking_easer') {
    const b = await single(sb.from('bookings').select('id, ref, assembler_id').eq('id', id));
    if (!b?.assembler_id) return { found: false };
    const e = await easerProfile(sb, b.assembler_id);
    if (!e) return { found: false };
    return { found: true, phone: e.phone, name: e.full_name || 'the Easer', ref: b.ref, bookingId: b.id };
  }
  if (type === 'case') {
    const c = await single(sb.from('operations_cases').select('id, case_ref, customer_name, customer_phone, booking_id').eq('id', id));
    if (!c) return { found: false };
    let phone = c.customer_phone;
    if (!phone && c.booking_id) {
      const b = await single(sb.from('bookings').select('customer_phone').eq('id', c.booking_id));
      phone = b?.customer_phone || null;
    }
    return { found: true, phone, name: c.customer_name || 'the caller', ref: c.case_ref, bookingId: c.booking_id || null, caseId: c.id };
  }
  if (type === 'easer') {
    const e = await easerProfile(sb, id);
    if (!e) return { found: false };
    return { found: true, phone: e.phone, name: e.full_name || 'the Easer', ref: null, bookingId: null };
  }
  if (type === 'partner') {
    const p = await single(sb.from('partner_leads').select('id, name, phone').eq('id', id));
    if (!p) return { found: false };
    return { found: true, phone: p.phone, name: p.name || 'the partner', ref: null, bookingId: null };
  }
  return { found: false };
}
