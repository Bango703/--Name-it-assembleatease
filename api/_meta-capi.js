// Meta Conversions API: tells Meta a booking happened, from the server, so an ad
// can be judged by bookings even when the browser blocks the Pixel. Same event
// ID as the browser Pixel (assets/js/cookie-consent.js), so Meta counts it once.
//
// Sends nothing unless all of these hold:
//   - META_PIXEL_ID and META_CAPI_ACCESS_TOKEN are set (off by default);
//   - the booking's own attribution says the customer accepted cookies
//     (adConsent, set by assets/js/attribution.js only after Accept);
//   - the booking exists.
// Email and phone are SHA-256 hashed before they leave. A failure here is logged
// and never affects the booking (Article 13: defined failure behavior).

import crypto from 'crypto';
import { getSupabase } from './_supabase.js';

const GRAPH_VERSION = 'v21.0';
const TIMEOUT_MS = 3000;

// The browser's analytics key for a booking milestone (book.html trackBookingFunnelOnce).
export const META_EVENT_FOR = { booking_confirmed: 'Schedule', quote_requested: 'Lead' };

export function metaEventId(ref, milestone) {
  return `booking:${ref}:${milestone}`;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function hashEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? sha256(v) : null;
}

export function hashPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `1${digits}`;
  return digits.length === 11 ? sha256(digits) : null;
}

function cookieValue(header, name) {
  const match = String(header || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** The fbc value Meta expects, from the _fbc cookie or the click ID kept with the booking. */
export function fbcFor({ cookie, attribution }) {
  const fromCookie = cookieValue(cookie, '_fbc');
  if (fromCookie) return fromCookie;
  if (attribution?.clickIdType !== 'fbclid' || !attribution.clickId) return null;
  const at = Date.parse(attribution.capturedAt || '') || Date.now();
  return `fb.1.${at}.${attribution.clickId}`;
}

export function buildMetaEvent({ booking, attribution, milestone, req, now = Date.now() }) {
  const eventName = META_EVENT_FOR[milestone];
  if (!eventName || !booking?.ref) return null;
  const headers = req?.headers || {};
  const userData = {};
  const em = hashEmail(booking.customer_email);
  const ph = hashPhone(booking.customer_phone);
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  const ip = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (ip) userData.client_ip_address = ip;
  if (headers['user-agent']) userData.client_user_agent = String(headers['user-agent']);
  const fbp = cookieValue(headers.cookie, '_fbp');
  if (fbp) userData.fbp = fbp;
  const fbc = fbcFor({ cookie: headers.cookie, attribution });
  if (fbc) userData.fbc = fbc;
  return {
    event_name: eventName,
    event_time: Math.floor(now / 1000),
    event_id: metaEventId(booking.ref, milestone),
    action_source: 'website',
    event_source_url: 'https://www.assembleatease.com/book',
    user_data: userData,
    // Limited Data Use: Meta processes this as a service provider for measurement
    // where state privacy law requires it (country/state 0 = Meta geolocates).
    // The Privacy Policy promises no sharing for cross-context behavioral advertising.
    data_processing_options: ['LDU'],
    data_processing_options_country: 0,
    data_processing_options_state: 0,
  };
}

async function loadAttribution(bookingId) {
  try {
    const { data, error } = await getSupabase().from('bookings').select('booking_attribution').eq('id', bookingId).maybeSingle();
    if (error) return null;
    return data?.booking_attribution && typeof data.booking_attribution === 'object' ? data.booking_attribution : null;
  } catch (_) {
    return null;
  }
}

/**
 * Report one booking milestone to Meta. Resolves to { status } and never throws:
 * 'disabled' | 'no_consent' | 'skipped' | 'sent' | 'failed'.
 */
export async function reportBookingToMeta({ booking, milestone, req, attribution, fetchImpl = globalThis.fetch } = {}) {
  try {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_CAPI_ACCESS_TOKEN;
    if (!pixelId || !token) return { status: 'disabled' };
    const attr = attribution || (booking?.id ? await loadAttribution(booking.id) : null);
    if (attr?.adConsent !== true) return { status: 'no_consent' };
    const event = buildMetaEvent({ booking, attribution: attr, milestone, req });
    if (!event) return { status: 'skipped' };

    const body = { data: [event] };
    if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`[meta-capi] ${event.event_name} for ${booking.ref} rejected: HTTP ${res.status} ${detail.slice(0, 200)}`);
        return { status: 'failed', httpStatus: res.status };
      }
      return { status: 'sent', eventId: event.event_id };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn('[meta-capi] report failed:', error?.message || error);
    return { status: 'failed' };
  }
}
