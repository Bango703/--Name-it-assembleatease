import { normalizeUsPhone } from './_phone.js';

/**
 * _owner-call.js — the ONE place that knows how to put the owner on the phone
 * with a customer without leaking the owner's personal number.
 *
 * WHAT WAS WRONG
 * The owner dashboard renders customer numbers as `tel:` links. Tapping one
 * opens the phone's own dialer, so the call goes out from the owner's personal
 * handset and the customer sees that number on their screen — and keeps it
 * forever. Every callback, every future question, and every time they pass the
 * number to a friend, it reaches a personal phone rather than the business.
 *
 * HOW THIS WORKS (click-to-call bridge)
 *   1. Owner presses Call in the dashboard.
 *   2. Telnyx dials the OWNER's phone, presented as the business number.
 *   3. When the owner answers, Telnyx dials the CUSTOMER, also presented as the
 *      business number, and bridges the two legs.
 *
 * The owner can be anywhere, on any phone, with no browser microphone
 * permission and no change to the Content-Security-Policy. Both legs bill at
 * ordinary outbound rates — roughly seven cents for a five-minute call.
 *
 * The customer only ever sees the business number. That is the entire point.
 */

/** Config for outbound owner calls, or a reason it is not available. */
export function ownerCallConfig(env = process.env) {
  const apiKey = String(env.TELNYX_API_KEY || '').trim();
  const appId = String(env.TELNYX_CALL_CONTROL_APP_ID || '').trim();
  const from = normalizeUsPhone(env.TELNYX_FROM_NUMBER);
  const ownerPhone = normalizeUsPhone(env.OWNER_PERSONAL_PHONE);

  const missing = [];
  if (!apiKey) missing.push('TELNYX_API_KEY');
  if (!appId) missing.push('TELNYX_CALL_CONTROL_APP_ID');
  if (!from) missing.push('TELNYX_FROM_NUMBER (valid E.164)');
  if (!ownerPhone) missing.push('OWNER_PERSONAL_PHONE (valid E.164)');

  return { apiKey, appId, from, ownerPhone, enabled: missing.length === 0, missing };
}

/**
 * Ring the owner first. The customer is dialled only once the owner picks up,
 * so a customer is never left listening to silence while the owner's phone
 * rings — and never called at all if the owner does not answer.
 *
 * `client_state` carries the customer number and booking through the webhook,
 * because Telnyx hands it back untouched on the answer event. It is base64 by
 * Telnyx's contract, not by ours, and holds nothing secret.
 */
export function buildOwnerLegRequest(config, { customerPhone, bookingId, bookingRef }) {
  const to = normalizeUsPhone(customerPhone);
  if (!to) return { ok: false, error: 'The customer does not have a valid US phone number on file.' };

  const clientState = Buffer.from(JSON.stringify({
    v: 1,
    stage: 'owner_leg',
    customer: to,
    bookingId: bookingId || null,
    ref: bookingRef || null,
  })).toString('base64');

  return {
    ok: true,
    customerPhone: to,
    body: {
      connection_id: config.appId,
      to: config.ownerPhone,
      from: config.from,
      client_state: clientState,
      // The owner's own phone should show the business identity too, so a
      // missed call in their recents is recognisable rather than a mystery.
      from_display_name: 'AssembleAtEase',
      timeout_secs: 30,
    },
  };
}

/** Parse the state Telnyx hands back on the answer webhook. */
export function parseClientState(encoded) {
  try {
    const parsed = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
    if (!parsed || parsed.v !== 1 || parsed.stage !== 'owner_leg') return null;
    if (!normalizeUsPhone(parsed.customer)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Second leg: dial the customer and join it to the answered owner leg.
 * `link_to` is what makes Telnyx bridge them rather than start a separate call.
 */
export function buildCustomerLegRequest(config, state, ownerCallControlId) {
  return {
    connection_id: config.appId,
    to: state.customer,
    from: config.from,
    from_display_name: 'AssembleAtEase',
    link_to: ownerCallControlId,
    timeout_secs: 45,
    client_state: Buffer.from(JSON.stringify({
      v: 1, stage: 'customer_leg', bookingId: state.bookingId || null, ref: state.ref || null,
    })).toString('base64'),
  };
}

/** POST a call to Telnyx. Never throws; the caller decides what a failure means. */
export async function placeCall(config, body, fetchImpl = fetch) {
  try {
    const resp = await fetchImpl('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail = json?.errors?.[0]?.detail || `HTTP ${resp.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, callControlId: json?.data?.call_control_id || null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
