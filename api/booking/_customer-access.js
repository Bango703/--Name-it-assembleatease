import { safeTokenHashMatch } from '../_payment-security.js';
import { bookingEmailMatches } from './_guest-booking-auth.js';
import { customerOwnsBooking } from './_customer-booking-auth.js';

/**
 * THE check that a request may act on a customer's booking. Read by every
 * customer booking endpoint (track, message, reschedule, cancel, photos, time
 * proposals, change orders, tips).
 *
 * Two proofs are accepted, and nothing else:
 *   - link:    the booking email plus the secure token from the customer's
 *              latest booking email (the website's booking page);
 *   - account: a signed-in AssembleAtEase app session whose email address is
 *              confirmed and owns the booking (api/customer/sign-in.js confirms
 *              it with a one-time code before any session exists).
 *
 * The proof only says who is asking. Every endpoint still applies its own
 * status, payment and fee rules after it.
 */

export function bearerToken(req) {
  const header = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** True when the request carries an app session instead of a link token. */
export function usesCustomerAccount(req, { token } = {}) {
  return !token && !!bearerToken(req);
}

function emailConfirmed(user) {
  return !!(user?.email_confirmed_at || user?.confirmed_at);
}

/**
 * The signed-in customer, or null. A session whose email is not confirmed is
 * no proof of owning anything sent to that address.
 */
export async function customerAccountUser(sb, req) {
  const jwt = bearerToken(req);
  if (!jwt) return null;
  try {
    const { data, error } = await sb.auth.getUser(jwt);
    if (error || !data?.user || !emailConfirmed(data.user)) return null;
    return data.user;
  } catch {
    return null;
  }
}

/**
 * { ok: true, via: 'link' | 'account', email, user } when the request may act
 * on this booking; { ok: false } otherwise. `email` is the booking's own
 * address, for endpoints that need one downstream.
 */
export async function customerBookingAccess(sb, req, booking, { email, token } = {}) {
  if (!booking) return { ok: false };
  if (token) {
    const ok = bookingEmailMatches(booking, email) && safeTokenHashMatch(token, booking.guest_mutation_token_hash);
    return ok ? { ok: true, via: 'link', email: booking.customer_email, user: null } : { ok: false };
  }
  const user = await customerAccountUser(sb, req);
  if (!user || !customerOwnsBooking(booking, user)) return { ok: false };
  return { ok: true, via: 'account', email: booking.customer_email, user };
}
