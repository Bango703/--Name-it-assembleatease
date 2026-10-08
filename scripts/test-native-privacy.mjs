import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const consent = readFileSync('assets/js/cookie-consent.js', 'utf8');
const attribution = readFileSync('assets/js/attribution.js', 'utf8');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function browser({ native = false, choice = 'accepted', path = '/book', existingGtag = false } = {}) {
  const injected = [], forwarded = [], listeners = {};
  const local = storage(choice ? { 'cookie-consent': choice } : {});
  const session = storage({ aaeBookingAttribution: JSON.stringify({ clickId: 'old-click', clickIdType: 'gclid' }) });
  const classes = new Set();
  const banner = {
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
    querySelector: () => ({}), getBoundingClientRect: () => ({ height: 100 }),
  };
  const document = {
    readyState: 'loading', referrer: 'https://www.google.com/search?q=assembly',
    documentElement: { dataset: {} },
    body: { style: { setProperty() {}, removeProperty() {} } },
    head: { appendChild(node) {
      injected.push(node);
      if (node.src === '/assets/js/attribution.js') { vm.runInContext(attribution, context); node.onload(); }
    } },
    createElement: () => ({}),
    getElementById: id => id === 'cookie-banner' ? banner : injected.find(node => node.id === id) || null,
    querySelector: selector => selector === 'link[rel="canonical"]' ? { href: 'https://www.assembleatease.com' + path } : null,
    querySelectorAll: () => [],
    addEventListener(name, handler) { (listeners[name] ||= []).push(handler); },
  };
  const context = vm.createContext({
    console, URL, URLSearchParams, document,
    location: new URL('https://www.assembleatease.com' + path + '?utm_source=google&utm_medium=organic&gclid=new-click'),
    navigator: {}, localStorage: local, sessionStorage: session,
    Event: class Event { constructor(type) { this.type = type; } },
    addEventListener(name, handler) { (listeners[name] ||= []).push(handler); },
    dispatchEvent(event) { for (const handler of listeners[event.type] || []) handler(event); },
  });
  context.window = context;
  if (native !== null) context.Capacitor = { isNativePlatform: () => native };
  if (existingGtag) context.gtag = (...args) => forwarded.push(args);
  return {
    context, injected, forwarded, local, session, classes,
    run(code) { vm.runInContext(code, context); },
    ready() { for (const handler of listeners.DOMContentLoaded || []) handler(); },
    storageEvent(value) { for (const handler of listeners.storage || []) handler({ key: 'cookie-consent', newValue: value }); },
    commands() { return Array.from(context.dataLayer || []).map(args => Array.from(args)); },
  };
}

// Cover customer, tracking and Easer application paths, including attribution
// loaded before consent and an acceptance stored by an earlier app version.
for (const path of ['/app', '/book', '/track', '/assembler/apply', '/assembler/my-assignments']) {
  for (const choice of ['accepted', 'declined', null]) {
    const app = browser({ native: true, choice, path });
    app.run(attribution);
    assert.equal(JSON.stringify(app.context.AAE_ATTRIBUTION.capture()), '{}');
    assert.equal(app.session.getItem('aaeBookingAttribution'), null, 'old ad identifiers are cleared');
    app.run(consent); app.ready();
    app.context.openCookiePreferences();
    app.context.acceptCookies();
    app.storageEvent('accepted');
    app.context.gtag('event', 'conversion', { send_to: 'should-not-send' });
    assert.equal(app.context.AAEAnalytics.trackOnce('booking_confirmed', {}, 'test'), false);
    assert.equal(app.context.AAEAnalytics.hasConsent(), false);
    assert.equal(app.context.AAEAnalytics.isExcluded(), true);
    assert.equal(app.injected.some(node => node.src), false, 'native app never loads Ads, GA, HubSpot or attribution scripts');
    assert.equal(app.commands().length, 0, 'native app does not queue events or advertising consent');
    assert.equal(app.local.getItem('cookie-consent'), choice, 'native actions cannot change the saved browser choice');
    assert.equal(app.classes.has('hidden'), true, 'native app does not offer an ineffective tracking opt-in');
  }
}

const priorTag = browser({ native: true, existingGtag: true });
priorTag.run(consent); priorTag.ready();
priorTag.context.gtag('event', 'conversion', {});
priorTag.context.gtag('consent', 'update', { ad_user_data: 'granted' });
assert.equal(priorTag.forwarded.length, 0, 'an existing gtag function cannot bypass the native gate');

// Browser visitors (including Capacitor's web platform) retain the consented
// measurement used to assess organic growth. Decline still blocks collection.
for (const native of [false, null]) {
  const web = browser({ native });
  web.run(consent); web.ready();
  assert.equal(web.context.AAEAnalytics.hasConsent(), true);
  assert.equal(web.injected.some(node => /googletagmanager/.test(node.src || '')), true);
  assert.equal(web.injected.some(node => /hs-scripts/.test(node.src || '')), true);
  assert.equal(web.context.AAEAnalytics.trackOnce('booking_confirmed', {}, 'test'), true);
  const optOut = browser({ native, choice: 'declined' });
  optOut.run(consent); optOut.ready();
  assert.equal(optOut.context.AAEAnalytics.hasConsent(), false);
  assert.equal(optOut.injected.some(node => node.src), false);
}

console.log('PASS native privacy: both app roles block optional Ads/GA/CRM and ad attribution; website consent remains unchanged.');
