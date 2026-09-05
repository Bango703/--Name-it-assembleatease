import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cookies = readFileSync('assets/js/cookie-consent.js', 'utf8');
const bookingPage = readFileSync('book.html', 'utf8');

assert.match(cookies, /function loadMeasurement\(\)/);
assert.match(cookies, /function grantAnalytics\(\)/);
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

console.log('Google Ads conversion checks passed.');