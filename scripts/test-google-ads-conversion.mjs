import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const cookies = readFileSync('assets/js/cookie-consent.js', 'utf8');
const bookingPage = readFileSync('book.html', 'utf8');

assert.match(cookies, /function loadMeasurement\(\)/);
assert.match(cookies, /function grantAnalytics\(\)/);
assert.match(cookies, /function bindPhoneCallTracking\(\)/);
assert.match(cookies, /target\.closest\('a\[href\^="tel:"\]'\)/);
assert.match(cookies, /window\.gtag\('event', PHONE_CLICK_EVENT,[\s\S]*?contact_method: 'phone'/);
assert.match(cookies, /bindPhoneCallTracking\(\);/);
assert.match(cookies, /if \(globalPrivacyControlEnabled\(\)\)[\s\S]*?return;[\s\S]*?loadMeasurement\(\)/);
assert.match(cookies, /function acceptCookies\(\)[\s\S]*?grantAnalytics\(\)/);
assert.ok(
  cookies.indexOf("window.gtag('consent', 'default'") < cookies.indexOf('function loadMeasurement()'),
  'Denied consent defaults must be established before Google measurement can load.',
);

const confirmationStart = bookingPage.indexOf('function showConfirmation(ref, isQuote, isScheduledAuthorization)');
const funnelEventStart = bookingPage.indexOf("trackBookingFunnelOnce('booking_completed'", confirmationStart);
assert.ok(confirmationStart >= 0 && funnelEventStart > confirmationStart, 'Booking confirmation tracking block must exist.');

const adsConversionBlock = bookingPage.slice(confirmationStart, funnelEventStart);
const [bookingBranch, quoteBranch = ''] = adsConversionBlock.split('} else if (ADS_QUOTE_CONVERSION) {');

assert.match(adsConversionBlock, /var ADS_BOOKING_CONVERSION = 'AW-16551666395\/7KS0CIjz1aMcENvFudQ9';/);
assert.match(adsConversionBlock, /var ADS_QUOTE_CONVERSION = 'AW-16551666395\/YSgLCNCQie8cENvFudQ9';/);
assert.match(bookingBranch, /if \(!isQuote\)/);
assert.match(bookingBranch, /send_to: ADS_BOOKING_CONVERSION/);
assert.match(bookingBranch, /transaction_id: ref/);
assert.match(bookingBranch, /value: Number\(BOOK\._grandTotalCents \|\| 0\) \/ 100/);
assert.match(bookingBranch, /currency: 'USD'/);
assert.match(quoteBranch, /send_to: ADS_QUOTE_CONVERSION/);
assert.match(quoteBranch, /transaction_id: ref/);
assert.doesNotMatch(quoteBranch, /\bvalue\s*:/, 'Quote leads must not report unapproved revenue.');
assert.doesNotMatch(quoteBranch, /\bcurrency\s*:/, 'Quote leads must not report a currency without value.');

const business = JSON.parse(readFileSync('business-artifacts/page-governance/site-governance.json', 'utf8')).business;
assert.ok(cookies.includes(`var BUSINESS_PHONE = '${business.phoneE164}';`));
assert.ok(cookies.includes(`var BUSINESS_PHONE_DISPLAY = '${business.phoneDisplay}';`));
const callConversion = 'AW-16551666395/NyDNCOCKq-8cENvFudQ9';

function phoneLink(href, text, label = null) {
  const attributes = new Map([['href', href]]);
  if (label !== null) attributes.set('aria-label', label);
  return {
    textNodes: [{ nodeValue: text }],
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

function consentHarness({ storedConsent = null, gpc = false } = {}) {
  const registry = new Map();
  const handlers = new Map();
  const links = [
    phoneLink('tel:+19792325139', 'Call (979) 232-5139', 'Call (979) 232-5139'),
    phoneLink('tel:+1-979-232-5139', '979-232-5139'),
    phoneLink('tel:+19792325139', 'Call us'),
    phoneLink('tel:+17372906129', '(737) 290-6129'),
  ];
  const icon = { nodeName: 'svg' };
  links[0].icon = icon;
  const document = {
    readyState: 'complete',
    documentElement: { dataset: {} },
    head: { appendChild: element => registry.set(element.id, element) },
    createElement: () => ({}),
    getElementById: id => registry.get(id) || null,
    querySelectorAll: selector => selector === 'a[href^="tel:"]' ? links : [],
    addEventListener: (name, callback) => handlers.set(name, callback),
    createTreeWalker: link => {
      let index = 0;
      return { nextNode: () => link.textNodes[index++] || null };
    },
  };
  const window = { location: { pathname: '/contact' } };
  const context = {
    document, window, navigator: { globalPrivacyControl: gpc },
    NodeFilter: { SHOW_TEXT: 4 },
    localStorage: { getItem: () => storedConsent, setItem: (_key, value) => { storedConsent = value; } },
  };
  vm.runInNewContext(cookies, context);
  const configurations = () => window.dataLayer.filter(entry => entry[0] === 'config' && entry[1] === callConversion);
  return { window, links, configurations, icon, registry };
}

const firstVisit = consentHarness();
assert.equal(firstVisit.configurations().length, 0, 'Call-number substitution must wait for consent.');
firstVisit.window.acceptCookies();
assert.equal(firstVisit.configurations().length, 1);
firstVisit.window.acceptCookies();
assert.equal(firstVisit.configurations().length, 1, 'Repeated consent must not add duplicate call configurations.');
const callback = firstVisit.configurations()[0][2].phone_conversion_callback;
assert.equal(firstVisit.configurations()[0][2].phone_conversion_number, business.phoneDisplay);
callback('(512) 555-0198', '+15125550198');
assert.equal(firstVisit.links[0].getAttribute('href'), 'tel:+15125550198');
assert.equal(firstVisit.links[0].textNodes[0].nodeValue, 'Call (512) 555-0198');
assert.equal(firstVisit.links[0].getAttribute('aria-label'), 'Call (512) 555-0198');
assert.equal(firstVisit.links[0].icon, firstVisit.icon, 'Nested icon markup must survive.');
assert.equal(firstVisit.links[1].textNodes[0].nodeValue, '(512) 555-0198');
assert.equal(firstVisit.links[2].textNodes[0].nodeValue, 'Call us', 'Action copy must not be overwritten.');
assert.equal(firstVisit.links[3].getAttribute('href'), 'tel:+17372906129', 'Never replace an owner, customer or Easer number.');
callback('(512) 555-0199', '+15125550199');
assert.equal(firstVisit.links[0].getAttribute('href'), 'tel:+15125550199', 'A repeated callback may refresh the forwarding number.');
firstVisit.window.declineCookies();
assert.equal(firstVisit.links[0].getAttribute('href'), 'tel:+19792325139');
assert.equal(firstVisit.links[0].getAttribute('aria-label'), 'Call (979) 232-5139');
assert.equal(firstVisit.links[0].textNodes[0].nodeValue, 'Call (979) 232-5139');
assert.equal(firstVisit.links[1].getAttribute('href'), 'tel:+1-979-232-5139');
callback('(512) 555-0198', '+15125550198');
assert.equal(firstVisit.links[0].getAttribute('href'), 'tel:+19792325139', 'A late callback after revocation must do nothing.');
firstVisit.window.acceptCookies();
assert.equal(firstVisit.configurations().length, 2);
callback('(512) 555-0198', '+15125550198');
assert.equal(firstVisit.links[0].getAttribute('href'), 'tel:+19792325139', 'An old consent-generation callback stays invalid after reacceptance.');
const newCallback = firstVisit.configurations()[1][2].phone_conversion_callback;
newCallback('<img src=x>', '+15125550198');
newCallback('(512) 555-0198', 'javascript:alert(1)');
newCallback('(512) 555-0198', '+15125550199');
assert.equal(firstVisit.links[0].getAttribute('href'), 'tel:+19792325139', 'Invalid or mismatched forwarding numbers must be rejected.');
newCallback('(512) 555-0198', '+15125550198');
assert.equal(firstVisit.links[0].getAttribute('href'), 'tel:+15125550198');
assert.equal(consentHarness({ storedConsent: 'accepted' }).configurations().length, 1);
assert.equal(consentHarness({ storedConsent: 'declined' }).configurations().length, 0);
const privacySignal = consentHarness({ storedConsent: 'accepted', gpc: true });
privacySignal.window.acceptCookies();
assert.equal(privacySignal.configurations().length, 0, 'GPC must remain respected even when Accept is called.');
assert.equal(privacySignal.registry.has('aae-gtag-script'), false);

const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
const csp = config.headers.flatMap(entry => entry.headers).find(header => header.key === 'Content-Security-Policy').value;
const directives = new Map(csp.split(';').map(part => {
  const [name, ...values] = part.trim().split(/\s+/);
  return [name, values];
}));
for (const origin of ['https://www.gstatic.com/wcm/', 'https://www.gstatic.com/call-tracking/', 'https://www.googleadservices.com']) {
  assert.ok(directives.get('script-src').includes(origin), `Call-tracking scripts must be permitted: ${origin}`);
}
assert.ok(directives.get('connect-src').includes('https://www.googleadservices.com'));
assert.deepEqual(directives.get('object-src'), ["'none'"]);
assert.deepEqual(directives.get('base-uri'), ["'self'"]);
assert.ok(!directives.get('script-src').includes('*') && !directives.get('script-src').includes("'unsafe-eval'"));

console.log('Google Ads conversion checks passed.');
