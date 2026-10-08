import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { cleanBookingAttribution, bookingAnalyticsContext, safeAcquisitionPath } from '../api/_booking-attribution.js';
import { cleanAcquisitionAttribution } from '../api/_attribution.js';
import { newRefCode, REF_CODE } from '../api/_partners.js';

const booking = readFileSync('book.html', 'utf8');
const consent = readFileSync('assets/js/cookie-consent.js', 'utf8');
const nav = readFileSync('assets/js/mobile-nav.js', 'utf8');
const funnel = booking.slice(booking.indexOf('var BOOKING_ANALYTICS_ATTEMPT'), booking.indexOf('var CHICAGO_DATE_FORMATTER'));
const outcome = booking.slice(booking.indexOf('function trackBookingConfirmation'), booking.indexOf('function showConfirmation(ref'));
const capture = readFileSync('assets/js/attribution.js', 'utf8');
assert.equal(cleanBookingAttribution, cleanAcquisitionAttribution, 'compatibility export must use the canonical server sanitizer');
assert.doesNotMatch(nav, /function (?:sanitizeAcquisition|captureBookingAttributionEntry)/, 'navigation must not keep a second capture implementation');

function storage(initial = {}, blocked = false) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { if (blocked) throw new Error('storage unavailable'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('storage unavailable'); values.set(key, String(value)); },
    removeItem(key) { if (blocked) throw new Error('storage unavailable'); values.delete(key); },
  };
}

function browser({ url = 'https://www.assembleatease.com/book?email=person@example.com&token=private', referrer = '', session = storage(), local = storage({ 'cookie-consent': 'accepted' }), gpc = false, canonical = 'https://www.assembleatease.com/book', loadAttribution = true } = {}) {
  const documentListeners = {};
  const windowListeners = {};
  const injected = [];
  const document = {
    readyState: 'loading', referrer,
    documentElement: { dataset: {} },
    body: { style: { setProperty() {}, removeProperty() {} } },
    head: { appendChild(node) { injected.push(node); if (loadAttribution && node.src === '/assets/js/attribution.js') { vm.runInContext(capture, context); node.onload(); } } },
    createElement() { return {}; },
    getElementById(id) { return injected.find(node => node.id === id) || null; },
    querySelector(selector) { return selector === 'link[rel="canonical"]' && canonical ? { href: canonical } : null; },
    querySelectorAll() { return []; },
    addEventListener(name, handler) { (documentListeners[name] ||= []).push(handler); },
  };
  const context = vm.createContext({
    console, URL, URLSearchParams, document, location: new URL(url),
    navigator: { globalPrivacyControl: gpc }, sessionStorage: session, localStorage: local,
    Event: class Event { constructor(type) { this.type = type; } },
    BOOK: { selectedServices: ['Furniture Assembly'], _grandTotalCents: 12900, _analytics: { service_market: 'central_texas', service_city: 'Austin' } },
    BOOKING_ATTRIBUTION: {},
    captureBookingAttribution() { return context.AAEAcquisition ? context.AAEAcquisition.capture() : {}; },
    addEventListener(name, handler) { (windowListeners[name] ||= []).push(handler); },
    dispatchEvent(event) { for (const handler of windowListeners[event.type] || []) handler(event); },
  });
  context.window = context;
  const events = name => Array.from(context.dataLayer || []).map(args => Array.from(args)).filter(args => args[0] === 'event' && (!name || args[1] === name));
  return {
    context, injected, events,
    run(code) { vm.runInContext(code, context); },
    ready() { for (const listener of documentListeners.DOMContentLoaded || []) listener(); },
    phoneClick() { for (const listener of documentListeners.click || []) listener({ target: { closest: () => ({ closest: () => null }) } }); },
  };
}

// A real first external source survives site navigation and a payment-provider return.
const sourceSession = storage();
const landing = browser({ url: 'https://www.assembleatease.com/furniture-assembly-austin-tx', canonical: 'https://www.assembleatease.com/furniture-assembly-austin-tx', referrer: 'https://www.google.com/search?q=furniture', session: sourceSession });
landing.run(capture);
landing.context.AAEAcquisition.capture();
for (const referrer of ['https://www.assembleatease.com/pricing', 'https://payments.klarna.com/private-token']) {
  const next = browser({ referrer, session: sourceSession });
  next.run(capture);
  const acquired = next.context.AAEAcquisition.capture();
  assert.equal(acquired.referrerHost, 'google.com');
  assert.equal(acquired.landingPath, '/furniture-assembly-austin-tx');
  assert.equal(JSON.stringify(acquired).includes('private-token'), false);
}
const legacySelf = browser({ session: storage({ aaeBookingAttribution: JSON.stringify({ referrerHost: 'www.assembleatease.com', landingPath: '/book' }) }), referrer: 'https://www.bing.com/search?q=assembly' });
legacySelf.run(capture);
assert.equal(legacySelf.context.AAEAcquisition.capture().referrerHost, 'bing.com');
const privateCampaign = browser({ url: 'https://www.assembleatease.com/book?utm_source=person@example.com&utm_campaign=5551234567', session: storage({}, true) });
privateCampaign.run(capture);
assert.equal(privateCampaign.context.AAEAcquisition.capture().utmSource, '');
assert.equal(privateCampaign.context.AAEAcquisition.capture().utmCampaign, '');

// Server normalization never calls an owner/self/payment referrer organic or rewrites old bookings.
assert.equal(cleanBookingAttribution({ referrerHost: 'www.google.com' }).channel, 'organic_search');
assert.equal(cleanBookingAttribution({ referrerHost: 'www.assembleatease.com' }).channel, 'unattributed');
assert.equal(cleanBookingAttribution({ utmSource: 'www.assembleatease.com', utmMedium: 'organic' }).channel, 'unattributed');
assert.equal(cleanBookingAttribution({ utmMedium: 'organic' }).channel, 'unattributed');
assert.equal(cleanBookingAttribution({ utmSource: 'unknown-campaign', utmMedium: 'organic' }).channel, 'unattributed');
assert.equal(cleanBookingAttribution({ referrerHost: 'checkout.stripe.com' }).channel, 'unattributed');
assert.equal(cleanBookingAttribution({ referrerHost: 'subdomain.assembleatease.com' }).channel, 'unattributed');
assert.equal(cleanBookingAttribution({ clickId: 'legacy-click', referrerHost: 'google.com' }).channel, 'paid_unclassified');
assert.equal(cleanBookingAttribution({ referrerHost: 'payments.klarna.com' }).source, 'direct');
assert.equal(cleanBookingAttribution({ clickId: 'ad-click', clickIdType: 'gclid' }).channel, 'paid_search');
assert.equal(cleanBookingAttribution({ clickId: 'ad-click', clickIdType: 'msclkid' }).source, 'bing');
assert.equal(cleanBookingAttribution({ referrerHost: 'm.facebook.com' }).channel, 'organic_social');
assert.equal(cleanBookingAttribution({ landingPath: '/easer-jobs-tyler-tx' }).entryAudience, 'easer');
assert.equal(safeAcquisitionPath('/book?token=private'), '');
assert.equal(safeAcquisitionPath('/Waited for Playwright code personal data'), '');
assert.equal(safeAcquisitionPath('/furniture-assembly-austin-tx'), '/furniture-assembly-austin-tx');
assert.equal(safeAcquisitionPath('/smart-home-installation-austin-tx'), '/smart-home-installation-austin-tx');
assert.equal(safeAcquisitionPath('/furniture-assembly-customer-name-tx'), '');
assert.equal(safeAcquisitionPath('/blog/article-slug'), '/blog');
assert.deepEqual(bookingAnalyticsContext({ city: 'Austin', zip: '78701' }), { service_market: 'central_texas', service_city: 'Austin' });
assert.deepEqual(bookingAnalyticsContext({ city: 'Tyler', zip: '75701' }), { service_market: 'unknown', service_city: 'Tyler' });
assert.equal(bookingAnalyticsContext({ city: 'person@example.com', zip: '' }).service_city, 'unknown');

// Published GBP and partner links keep useful identifiers, never contact/free text.
for (const [source, medium, campaign, content, channel] of [
  ['google', 'organic', 'gbp', 'website', 'organic_search'],
  ['google', 'organic', 'gbp', 'book', 'organic_search'],
  ['partner', 'referral', 'austin_partners_oct2026', 'example-property', 'referral'],
  ['partner', 'email', 'partner_outreach_oct2026', 'example-store', 'email'],
  ['partner', 'referral', 'ema86q', '', 'referral'],
  ['partner', 'referral', 'bpvk4b', '', 'referral'],
  ['partner', 'referral', 'abcdef', '', 'referral'],
  ['partner', 'referral', '2abcde', '', 'referral'],
  ['partner', 'referral', '234567', '', 'referral'],
  ['owner', 'email', 'rebook', '', 'email'],
  ['sora', 'voice', '', '', 'campaign'],
]) {
  const tagged = browser({ url: 'https://www.assembleatease.com/business?' + new URLSearchParams({ utm_source: source, utm_medium: medium, utm_campaign: campaign, utm_content: content, utm_term: 'private customer details' }) });
  tagged.run(capture);
  const acquired = tagged.context.AAEAcquisition.capture();
  const normalized = cleanBookingAttribution(acquired);
  assert.equal(normalized.channel, channel);
  assert.equal(normalized.utmCampaign || '', campaign);
  assert.equal(normalized.utmContent || '', content);
  assert.equal(acquired.utmTerm, undefined);
  assert.equal(normalized.utmTerm, undefined);
  tagged.run(consent); tagged.ready();
  const config = Array.from(tagged.context.dataLayer).map(args => Array.from(args)).find(args => args[0] === 'set' && args[1]?.page_location)?.[1];
  assert.equal(config.campaign_source, source);
  assert.equal(config.campaign_medium, medium);
  assert.equal(config.campaign_name || '', campaign);
  assert.equal(config.campaign_content || '', content);
  assert.equal(config.page_location.includes('?'), false);
  assert.equal(JSON.stringify(config).includes('private customer details'), false);
  const commands = Array.from(tagged.context.dataLayer).map(args => Array.from(args));
  assert.ok(commands.findIndex(args => args[0] === 'set' && args[1]?.page_location) < commands.findIndex(args => args[0] === 'config'), 'all destinations, including phone tracking, receive the safe page context first');
}
assert.equal(cleanBookingAttribution({ utmSource: 'partner', utmMedium: 'email', referrerHost: 'facebook.com' }).channel, 'email');
assert.equal(cleanBookingAttribution({ utmSource: 'partner', referrerHost: 'google.com' }).channel, 'campaign');
const privateTags = cleanBookingAttribution({ utmSource: 'partner', utmCampaign: 'partner_outreach_oct2026', utmContent: 'phone-512-555-1234', utmTerm: 'private customer details' });
assert.equal(privateTags.utmContent, undefined);
assert.equal(privateTags.utmTerm, undefined);
assert.equal(cleanBookingAttribution({ utmSource: 'partner', utmCampaign: 'personal-information' }).utmCampaign, undefined);
for (const campaign of ['private_text', '5125551234', 'person@example.com', 'private-ref-token']) {
  assert.equal(cleanBookingAttribution({ utmSource: 'partner', utmMedium: 'referral', utmCampaign: campaign }).utmCampaign, undefined);
}
assert.equal(cleanBookingAttribution({ utmSource: 'google', utmCampaign: 'ema86q' }).utmCampaign, undefined, 'short manual codes are reserved for the existing partner channel');
for (let i = 0; i < 50; i++) {
  const code = newRefCode();
  assert.match(code, REF_CODE);
  const generated = browser({ url: 'https://www.assembleatease.com/book?utm_source=partner&utm_medium=referral&utm_campaign=' + code });
  generated.run(capture);
  assert.equal(cleanAcquisitionAttribution(generated.context.AAE_ATTRIBUTION.capture()).utmCampaign, code);
}

// The standalone application/recruitment modules use the exact same capture
// without loading navigation, and retain the original city recruitment page.
const applicationSession = storage();
const recruit = browser({ url: 'https://www.assembleatease.com/easer-jobs-tyler-tx', canonical: 'https://www.assembleatease.com/easer-jobs-tyler-tx', referrer: 'https://www.google.com/search', session: applicationSession });
recruit.run(capture); recruit.ready();
assert.equal(recruit.context.AAE_ATTRIBUTION, recruit.context.AAEAcquisition);
const application = browser({ url: 'https://www.assembleatease.com/assembler/apply', canonical: 'https://www.assembleatease.com/assembler/apply', referrer: 'https://www.assembleatease.com/easer-jobs-tyler-tx', session: applicationSession });
application.run(capture); application.ready();
assert.equal(application.context.AAE_ATTRIBUTION.capture('/assembler/apply').landingPath, '/easer-jobs-tyler-tx');
assert.equal(cleanAcquisitionAttribution(application.context.AAE_ATTRIBUTION.capture()).entryAudience, 'easer');

const delayedDependency = browser({ loadAttribution: false });
delayedDependency.run(funnel); delayedDependency.run(consent); delayedDependency.ready();
assert.equal(delayedDependency.injected.some(node => /gtag\/js|hs-scripts/.test(node.src || '')), false, 'optional tags wait for the canonical source helper');
delayedDependency.run(capture);
delayedDependency.injected.find(node => node.src === '/assets/js/attribution.js').onload();
assert.equal(delayedDependency.events('job_plan_started').length, 1);

// The inline booking start precedes deferred consent initialization in the real page.
const analyticsSession = storage();
const customer = browser({ session: analyticsSession, referrer: 'https://example.com/path?email=person@example.com' });
customer.run(funnel);
assert.equal(customer.context.bookingAnalyticsQueue.length, 1);
customer.run(consent);
customer.run(outcome);
customer.ready();
assert.equal(customer.events('job_plan_started').length, 1, 'start must survive deferred gtag initialization');
customer.context.trackBookingFunnelOnce('begin_checkout', { value: 129 });
customer.context.trackBookingFunnelOnce('begin_checkout', { value: 129 });
assert.equal(customer.events('begin_checkout').length, 1, 'milestone repeats in one attempt dedupe');
customer.context.trackBookingConfirmation('AAE-ONE', false, false);
customer.context.trackBookingConfirmation('AAE-ONE', false, false);
customer.context.trackBookingConfirmation('AAE-TWO', false, true);
customer.context.trackBookingConfirmation('AAE-QUOTE', true, false);
assert.equal(customer.events('booking_confirmed').length, 2, 'different references in one tab both count');
assert.equal(customer.events('quote_requested').length, 1);
assert.equal(customer.events('booking_completed').length, 3, 'compatibility alias dedupes by reference');
assert.equal(customer.events('purchase').length, 0);
for (const event of [...customer.events('booking_confirmed'), ...customer.events('quote_requested'), ...customer.events('booking_completed')]) {
  assert.equal(event[2].outcome_stage, 'form_confirmation');
  assert.equal(event[2].value, undefined, 'confirmation is not captured revenue');
  assert.equal(event[2].transaction_id, undefined, 'booking references stay out of GA4 outcome parameters');
  assert.equal(event[2].service_city, 'Austin');
}
assert.ok(customer.events('booking_completed').every(event => event[2].deprecated_event === true));
const serialized = JSON.stringify(customer.context.dataLayer.filter(args => args[1] !== 'conversion'));
assert.equal(serialized.includes('person@example.com'), false);
assert.equal(serialized.includes('token=private'), false);

// Reload/recovery of the same booking does not count it twice; a new page is a new funnel attempt.
const recovery = browser({ session: analyticsSession });
recovery.run(funnel); recovery.run(consent); recovery.run(outcome); recovery.ready();
recovery.context.trackBookingConfirmation('AAE-ONE', false, false);
assert.equal(recovery.events('booking_confirmed').length, 0);
assert.equal(recovery.events('job_plan_started').length, 1);

// The privacy notice promises optional tools only after Accept. No choice,
// explicit decline and GPC must produce neither tags, events nor attribution.
for (const options of [
  { local: storage() },
  { local: storage({ 'cookie-consent': 'declined' }) },
  { local: storage({ 'cookie-consent': 'accepted' }), gpc: true },
]) {
  const session = storage({ aaeBookingAttribution: JSON.stringify({ utmSource: 'google', clickId: 'old-click' }) });
  const optedOut = browser({ ...options, session, url: 'https://www.assembleatease.com/book?utm_source=google&utm_medium=organic&gclid=optional-click' });
  optedOut.run(capture);
  assert.equal(JSON.stringify(optedOut.context.AAEAcquisition.capture()), '{}');
  assert.equal(session.getItem('aaeBookingAttribution'), null);
  optedOut.run(funnel); optedOut.run(consent); optedOut.run(outcome); optedOut.ready();
  optedOut.context.trackBookingConfirmation('AAE-NO-CONSENT', false, false);
  optedOut.phoneClick();
  optedOut.context.gtag('event', 'should_not_be_queued', {});
  assert.equal(optedOut.events().length, 0);
  assert.equal(optedOut.context.bookingAnalyticsQueue.length, 0, 'pre-consent actions must not be replayed later');
  assert.equal(optedOut.injected.some(node => node.src), false, 'no optional Google or HubSpot script before Accept');
  assert.equal(session.getItem('aaeAdsConfirmation:AAE-NO-CONSENT:booking'), null);
  if (options.gpc) {
    optedOut.context.acceptCookies();
    assert.equal(optedOut.context.AAEAnalytics.hasConsent(), false, 'GPC overrides a stored or new acceptance');
    assert.equal(optedOut.injected.some(node => node.src), false);
  }
}

const consentSession = storage();
const choice = browser({ local: storage(), session: consentSession, url: 'https://www.assembleatease.com/book?utm_source=google&utm_medium=organic&utm_campaign=gbp' });
choice.run(capture); choice.run(funnel); choice.run(consent); choice.run(outcome); choice.ready();
assert.equal(choice.events().length, 0);
choice.context.acceptCookies();
assert.equal(choice.context.AAEAnalytics.hasConsent(), true);
assert.equal(choice.events('job_plan_started').length, 1);
assert.equal(JSON.parse(consentSession.getItem('aaeAcquisitionAttribution')).utmCampaign, 'gbp');
assert.equal(choice.injected.filter(node => /gtag\/js/.test(node.src || '')).length, 1);
assert.equal(choice.injected.filter(node => /hs-scripts/.test(node.src || '')).length, 1);
choice.context.acceptCookies();
assert.equal(choice.injected.filter(node => /gtag\/js|hs-scripts/.test(node.src || '')).length, 2, 'repeated acceptance does not duplicate optional scripts');
choice.injected.find(node => /gtag\/js/.test(node.src || '')).onload();
choice.context.trackBookingConfirmation('AAE-ACCEPTED', false, false);
const acceptedEvents = choice.events().length;
choice.context.declineCookies();
choice.context.trackBookingConfirmation('AAE-AFTER-REVOKE', false, false);
choice.phoneClick();
assert.equal(choice.events().length, acceptedEvents, 'withdrawal blocks all later booking, Ads and phone events');
assert.equal(choice.context.AAEAnalytics.hasConsent(), false);
assert.equal(choice.context['ga-disable-G-ZN45GP8D25'], true);
assert.equal(consentSession.getItem('aaeBookingAttribution'), null);
assert.equal(consentSession.getItem('aaeAcquisitionAttribution'), null);
assert.equal(JSON.stringify(choice.context.AAEAcquisition.capture()), '{}');

const downloading = browser();
downloading.run(capture); downloading.run(funnel); downloading.run(consent); downloading.ready();
assert.equal(downloading.events('job_plan_started').length, 1);
downloading.context.declineCookies();
downloading.injected.find(node => /gtag\/js/.test(node.src || '')).onload();
assert.equal(downloading.events().length, 0, 'a delayed tag cannot replay events after withdrawal');
assert.equal(Array.from(downloading.context.dataLayer).some(args => args[0] === 'config'), false);

const anotherTab = browser();
anotherTab.run(capture); anotherTab.run(funnel); anotherTab.run(consent); anotherTab.run(outcome); anotherTab.ready();
anotherTab.context.dispatchEvent({ type: 'storage', key: 'cookie-consent', newValue: 'declined' });
anotherTab.context.trackBookingConfirmation('AAE-OTHER-TAB-REVOKED', false, false);
assert.equal(anotherTab.events().length, 0);
assert.equal(JSON.stringify(anotherTab.context.AAEAcquisition.capture()), '{}');

for (const options of [
  { local: storage({ 'aae-analytics-internal': '1' }) },
  { url: 'http://localhost:3000/book' },
  { url: 'https://preview.vercel.app/book' },
  { url: 'https://www.assembleatease.com/owner/' },
  { url: 'https://www.assembleatease.com/assembler/my-assignments' },
  { gpc: true },
]) {
  const excluded = browser(options);
  excluded.run(funnel); excluded.run(consent); excluded.run(outcome); excluded.ready();
  excluded.context.trackBookingConfirmation('AAE-TEST', false, false);
  assert.equal(excluded.events().length, 0, 'excluded traffic cannot emit outcome events');
  assert.equal(excluded.injected.some(node => /gtag\/js/.test(node.src || '')), false);
}
const easer = browser({ url: 'https://www.assembleatease.com/assembler/apply', canonical: 'https://www.assembleatease.com/assembler/apply' });
easer.run(consent); easer.ready();
assert.equal(easer.context.AAEAnalytics.isExcluded(), false, 'public Easer recruitment remains measurable');
easer.context.AAEAnalytics.trackOnce('test_only_in_vm', {}, 'test');
assert.equal(easer.events('test_only_in_vm')[0][2].audience_type, 'easer');

const unavailable = browser({ session: storage({}, true), local: storage({}, true) });
unavailable.run(funnel); unavailable.run(consent); unavailable.run(outcome); unavailable.ready();
unavailable.context.acceptCookies();
assert.doesNotThrow(() => unavailable.context.trackBookingConfirmation('AAE-STORAGE', false, false));
unavailable.context.trackBookingConfirmation('AAE-STORAGE', false, false);
assert.equal(unavailable.events('booking_confirmed').length, 1, 'in-memory dedupe survives disabled storage');
unavailable.context.AAEAnalytics.trackOnce = () => { throw new Error('analytics unavailable'); };
assert.doesNotThrow(() => unavailable.context.trackBookingFunnelOnce('contact_completed'));

// B2B intake carries the shared source, counts a lead only on success and stays
// usable when analytics/capture/storage is unavailable. All fetches are mocked.
const businessPage = readFileSync('business.html', 'utf8');
const businessForm = businessPage.slice(businessPage.indexOf('async function sendB2B()'), businessPage.indexOf("document.addEventListener('DOMContentLoaded'", businessPage.indexOf('async function sendB2B()')));
const business = browser({ canonical: 'https://www.assembleatease.com/business' });
business.run(consent); business.ready();
const fields = Object.fromEntries(Object.entries({ 'b-name': 'Casey', 'b-company': 'Example', 'b-email': 'casey@example.com', 'b-location': 'Austin', 'b-timeline': 'Flexible', 'b-type': 'Office assembly', 'b-frequency': 'Monthly', 'b-details': 'Two desks', 'b-err': '', 'b-btn': '', 'b2b-form-fields': '', 'b-success': '', 'b2b-form-wrap': '' }).map(([id, value]) => [id, { value, style: {}, scrollIntoView() {} }]));
business.context.document.getElementById = id => fields[id];
const businessRequests = [];
business.context.AAE_ATTRIBUTION = { capture: () => ({ utmSource: 'partner', utmMedium: 'referral' }) };
business.context.fetch = async (_url, req) => { businessRequests.push(JSON.parse(req.body)); return { ok: true, json: async () => ({ ref: 'B2B-LOCAL' }) }; };
business.run(businessForm);
await business.context.sendB2B(); await business.context.sendB2B();
assert.equal(businessRequests[0].attribution.utmSource, 'partner');
assert.equal(business.events('business_inquiry_submitted').length, 1);
assert.equal(business.events('business_inquiry_submitted')[0][2].outcome_stage, 'inquiry_received');
assert.equal(business.events('business_inquiry_submitted')[0][2].value, undefined);
assert.equal(JSON.stringify(business.context.dataLayer).includes('casey@example.com'), false);
business.context.AAE_ATTRIBUTION.capture = () => { throw new Error('capture unavailable'); };
business.context.AAEAnalytics.trackOnce = () => { throw new Error('analytics unavailable'); };
await business.context.sendB2B();
assert.equal(fields['b-success'].style.display, 'block');
assert.deepEqual(businessRequests[2].attribution, {});

console.log('Organic measurement: source preservation, privacy, consent, internal exclusion, event semantics and dedupe PASS');
