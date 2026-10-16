#!/usr/bin/env node
// Owner, 2026-10-15: "instead of switching on to understand terms and agreement,
// could say by book now you are agreeing to the terms and privacy. stop creating
// friction." Booking is the agreement, stated beside the button with the links;
// the server records which notice the customer saw.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConsentMethod, CONSENT_METHODS } from '../api/_legal-consent.js';

const read = f => readFileSync(f, 'utf8');
const app = read('mobile/ios/Customer/Customer/CustomerBooking.swift');
assert.doesNotMatch(app, /Toggle\(isOn: \$flow\.agreed\)|var agreed/, 'no terms switch in the app');
assert.match(app, /order\["termsConsentMethod"\] = "app_book_button_notice"/);
assert.ok(app.includes('By tapping \\(title), you agree to the Terms of Service and acknowledge the Privacy Notice.'), 'the notice names the button it sits under');
assert.match(app, /agreementNotice: true\)/, 'the booking button carries the notice');

const web = read('book.html');
assert.doesNotMatch(web, /id="s5-ack"/, 'no terms checkbox on the website');
assert.match(web, /By submitting this booking, you agree to the current <a href="\/terms"/);
assert.match(web, /termsConsentMethod: 'web_book_button_notice'/);
const notice = web.indexOf('id="s5-ack-notice"');
assert.ok(notice > 0 && web.indexOf('id="s5-submit"') - notice < 1000, 'the notice sits right above the button');

assert.equal(normalizeConsentMethod('app_book_button_notice'), 'app_book_button_notice');
assert.equal(normalizeConsentMethod('anything else'), 'online_checkout_checkbox', 'only known methods are recorded');
assert.deepEqual([...CONSENT_METHODS].sort(), ['app_book_button_notice', 'online_checkout_checkbox', 'web_book_button_notice']);
const booking = read('api/booking.js');
assert.match(booking, /buildCustomerConsentRecord\(req, consentMethod\)/, 'the stored record says how the customer agreed');
console.log('PASS consent notice: no switch or checkbox, agreement stated beside the button, method recorded truthfully.');
