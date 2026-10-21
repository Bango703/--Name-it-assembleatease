#!/usr/bin/env node
// Meta ads measurement (owner, 2026-10-21): a Facebook ad is judged by bookings.
// Off until configured, only after the customer accepts cookies, hashed contact
// data, Limited Data Use, one event per booking (browser + server share an ID),
// and never able to affect a booking.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

const { cleanAcquisitionAttribution } = await import('../api/_attribution.js');
const capi = await import('../api/_meta-capi.js');

// ── Attribution: paid social is its own channel; fbclid alone is not "paid" ──
{
  const c = (x) => cleanAcquisitionAttribution(x);
  assert.equal(c({ utmSource: 'facebook', utmMedium: 'paid_social', utmCampaign: 'meta_offer' }).channel, 'paid_social');
  assert.equal(c({ utmSource: 'facebook', utmMedium: 'paid_social', utmCampaign: 'meta_offer' }).utmCampaign, 'meta_offer');
  assert.equal(c({ utmSource: 'facebook', utmMedium: 'cpc' }).channel, 'paid_social', 'a Facebook cpc tag is not paid search');
  const organic = c({ utmSource: 'facebook', utmMedium: 'social', utmCampaign: 'offer', clickId: 'IwAR1x', clickIdType: 'fbclid' });
  assert.equal(organic.channel, 'organic_social', 'Facebook adds fbclid to organic clicks too');
  assert.equal(organic.clickIdType, 'fbclid', 'the click ID is kept for Meta');
  assert.equal(c({ clickId: 'IwAR1x', clickIdType: 'fbclid' }).source, 'facebook');
  assert.equal(c({ utmSource: 'google', utmMedium: 'cpc', clickId: 'Cj0', clickIdType: 'gclid' }).channel, 'paid_search', 'Google Ads unchanged');
  for (const campaign of ['offer', 'service_spotlight', 'assemblecash', 'page_profile']) {
    assert.equal(c({ utmSource: 'facebook', utmMedium: 'social', utmCampaign: campaign }).utmCampaign, campaign, `${campaign} is kept`);
  }
  assert.equal(c({ adConsent: true }).adConsent, true);
  assert.equal(c({ adConsent: 'yes' }).adConsent, undefined, 'only a literal true counts');
  assert.equal(c({}).adConsent, undefined);
  const client = read('assets/js/attribution.js');
  assert.match(client, /'paid_social', 'paidsocial'\]\.indexOf\(medium\)/, 'the browser mirror accepts paid_social');
  assert.match(client, /texas\|offer\|service\|assemblecash\|page\|meta\)/, 'the browser mirror keeps the same campaign names');
  assert.match(client, /'gbraid', 'wbraid', 'fbclid'\]\.filter/, 'the browser captures fbclid');
  assert.match(client, /function withAdConsent\(value\)/);
  assert.match(client, /if \(!acquisitionAllowed\(\)\) \{ clearAcquisition\(\); return \{\}; \}/, 'nothing, including adConsent, without Accept');
  assert.match(read('api/owner/_acquisition-report.js'), /paid_social: 'Paid social'/, 'the owner report names the channel');
}
console.log('PASS attribution: paid social channel, fbclid kept but not paid, Facebook campaigns kept, consent flag');

// ── Conversions API: off, consent, hashing, LDU, failure ────────────────────
{
  const booking = { id: 'b1', ref: 'AAE-TEST1', customer_email: ' Pat@Example.com ', customer_phone: '(979) 232-5139' };
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'UA', cookie: '_fbp=fb.1.1.123; other=1' } };
  const consented = { adConsent: true, clickId: 'IwAR1x', clickIdType: 'fbclid', capturedAt: '2026-10-21T10:00:00.000Z' };
  let calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => '' }; };

  delete process.env.META_PIXEL_ID; delete process.env.META_CAPI_ACCESS_TOKEN;
  assert.equal((await capi.reportBookingToMeta({ booking, milestone: 'booking_confirmed', req, attribution: consented, fetchImpl })).status, 'disabled');
  process.env.META_PIXEL_ID = '1234567890'; process.env.META_CAPI_ACCESS_TOKEN = 'token';
  assert.equal((await capi.reportBookingToMeta({ booking, milestone: 'booking_confirmed', req, attribution: { source: 'direct' }, fetchImpl })).status, 'no_consent');
  assert.equal(calls.length, 0, 'nothing leaves without consent');

  const sent = await capi.reportBookingToMeta({ booking, milestone: 'booking_confirmed', req, attribution: consented, fetchImpl });
  assert.equal(sent.status, 'sent');
  assert.match(calls[0].url, /graph\.facebook\.com\/v\d+\.\d+\/1234567890\/events\?access_token=token/);
  const event = calls[0].body.data[0];
  assert.equal(event.event_name, 'Schedule');
  assert.equal(event.event_id, 'booking:AAE-TEST1:booking_confirmed');
  assert.deepEqual(event.user_data.em, [sha('pat@example.com')], 'email lowercased, trimmed, hashed');
  assert.deepEqual(event.user_data.ph, [sha('19792325139')], 'phone with country code, hashed');
  assert.equal(JSON.stringify(event).includes('Pat@Example.com'), false, 'no plain email');
  assert.equal(event.user_data.client_ip_address, '203.0.113.9');
  assert.equal(event.user_data.fbp, 'fb.1.1.123');
  assert.equal(event.user_data.fbc, `fb.1.${Date.parse(consented.capturedAt)}.IwAR1x`);
  assert.deepEqual(event.data_processing_options, ['LDU'], 'Limited Data Use on every event');
  assert.equal((await capi.reportBookingToMeta({ booking, milestone: 'quote_requested', req, attribution: consented, fetchImpl })).status, 'sent');
  assert.equal(calls[1].body.data[0].event_name, 'Lead');

  const failing = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  assert.equal((await capi.reportBookingToMeta({ booking, milestone: 'booking_confirmed', req, attribution: consented, fetchImpl: failing })).status, 'failed');
  const throwing = async () => { throw new Error('network down'); };
  assert.equal((await capi.reportBookingToMeta({ booking, milestone: 'booking_confirmed', req, attribution: consented, fetchImpl: throwing })).status, 'failed', 'never throws');
  delete process.env.META_PIXEL_ID; delete process.env.META_CAPI_ACCESS_TOKEN;
}
console.log('PASS Conversions API: off by default, consent required, hashed, Limited Data Use, failures contained');

// ── One booking, one event: browser and server share the ID ─────────────────
{
  const book = read('book.html');
  assert.match(book, /var key = \(bookingRef \? 'booking:' \+ bookingRef : 'attempt:' \+ BOOKING_ANALYTICS_ATTEMPT\) \+ ':' \+ eventName;/,
    'the browser key is booking:<ref>:<event>, the same as metaEventId');
  assert.equal(capi.metaEventId('AAE-X', 'booking_confirmed'), 'booking:AAE-X:booking_confirmed');
  const consent = read('assets/js/cookie-consent.js');
  assert.match(consent, /var META_EVENTS = \{ booking_confirmed: 'Schedule', quote_requested: 'Lead', begin_checkout: 'InitiateCheckout' \};/);
  assert.deepEqual(capi.META_EVENT_FOR, { booking_confirmed: 'Schedule', quote_requested: 'Lead' }, 'server and browser name the events alike');
  assert.match(consent, /window\.fbq\('track', metaName, data, \{ eventID: String\(key \|\| eventName\) \}\)/);
  assert.match(consent, /function loadMetaPixel\(\) \{\n    if \(!META_PIXEL_ID \|\| !analyticsAllowed\(\)\) return;/, 'only after Accept, never cookieless');
  assert.match(consent, /loadHubspot\(\);\n    loadMetaPixel\(\);/, 'loaded from the Accept path');
  assert.match(consent, /if \(window\.fbq\) window\.fbq\('consent', 'revoke'\);/, 'Decline revokes');
  assert.match(consent, /fbq\('dataProcessingOptions', \['LDU'\], 0, 0\);/);
  // Turning the Pixel on requires the Privacy Policy to say so.
  const pixelId = (consent.match(/var META_PIXEL_ID = '([^']*)';/) || [])[1];
  assert.ok(pixelId !== undefined, 'META_PIXEL_ID constant present');
  if (pixelId) assert.match(read('privacy.html'), /Meta Pixel/, 'Pixel enabled: the Privacy Policy must disclose Meta');
  const csp = read('vercel.json');
  assert.match(csp, /script-src [^;]*https:\/\/connect\.facebook\.net/);
  assert.match(csp, /connect-src [^;]*https:\/\/www\.facebook\.com/);
  assert.match(read('api/booking-confirmed.js'), /await reportBookingToMeta\(\{ booking, milestone: 'booking_confirmed', req \}\);/);
  assert.match(read('api/booking.js'), /milestone: quoteRequested \? 'quote_requested' : 'booking_confirmed'/);
}
console.log('PASS one booking is one event; Pixel only after Accept; enabling it requires the privacy disclosure');
