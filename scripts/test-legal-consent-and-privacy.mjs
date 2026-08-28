import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CUSTOMER_TERMS_VERSION,
  PRIVACY_NOTICE_VERSION,
  buildCustomerConsentRecord,
  validateCustomerLegalConsent,
} from '../api/_legal-consent.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';

const ROOT = process.cwd();
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

assert.equal(validateCustomerLegalConsent({}).code, 'TERMS_ACCEPTANCE_REQUIRED');
assert.equal(validateCustomerLegalConsent({
  termsAccepted: true,
  termsVersion: 'stale',
  privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
}).code, 'LEGAL_VERSION_CHANGED');
assert.equal(validateCustomerLegalConsent({
  termsAccepted: true,
  termsVersion: CUSTOMER_TERMS_VERSION,
  privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
}).ok, true);
assert.equal(CUSTOMER_TERMS_VERSION, '2026-08-27-sms-v1');
assert.equal(PRIVACY_NOTICE_VERSION, '2026-08-27-sms-v1');

const record = buildCustomerConsentRecord({
  headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.1', 'user-agent': 'Legal test browser' },
}, 'online_checkout_checkbox');
assert.equal(record.customer_terms_version, CUSTOMER_TERMS_VERSION);
assert.equal(record.customer_privacy_notice_version, PRIVACY_NOTICE_VERSION);
assert.equal(record.customer_terms_acceptance_method, 'online_checkout_checkbox');
assert.match(record.customer_terms_acceptance_ip_hash, /^[a-f0-9]{64}$/);
assert.ok(!JSON.stringify(record).includes('203.0.113.8'), 'Raw IP must not be stored in consent evidence');

const bookingApi = read('api/booking.js');
assert.match(bookingApi, /validateCustomerLegalConsent/);
assert.match(bookingApi, /\.\.\.buildCustomerConsentRecord\(req\)/);
assert.match(bookingApi, /LEGAL_CONSENT_MIGRATION_REQUIRED/);
const bookingPage = read('book.html');
assert.match(bookingPage, /fetch\('\/api\/legal-config'/);
assert.match(bookingPage, /termsAccepted: ackEl\.checked === true/);
assert.match(bookingPage, /privacyNoticeVersion: legalConfig\.privacyNoticeVersion/);
assert.match(bookingPage, /id="s5-sms-consent"/);
assert.match(bookingPage, /Consent is not a condition of purchase/);
assert.match(bookingPage, /\/terms#sms-terms/);

const customerTerms = read('terms.html');
assert.match(customerTerms, /id="sms-terms"/);
assert.match(customerTerms, /replying <strong>STOP<\/strong>/);
assert.match(customerTerms, /Reply <strong>HELP<\/strong>/);
const privacyNotice = read('privacy.html');
assert.match(privacyNotice, /We do not sell or share mobile phone numbers, SMS opt-in data, or SMS consent/);

const ownerApi = read('api/owner/create-booking.js');
assert.match(ownerApi, /owner_attested_customer_agreement/);
assert.match(ownerApi, /validateCustomerLegalConsent/);
assert.match(ownerApi, /Review and track booking/);
const ownerPage = read('owner/index.html');
assert.match(ownerPage, /id="ocb-customer-terms"/);
assert.match(ownerPage, /customerTermsAcceptedByOwner/);

const migration = read('api/migrations/065_customer_legal_consent.sql');
for (const column of [
  'customer_terms_version',
  'customer_terms_accepted_at',
  'customer_terms_acceptance_method',
  'customer_privacy_notice_version',
  'customer_terms_acceptance_ip_hash',
  'customer_terms_acceptance_user_agent',
]) assert.ok(migration.includes(column), `Migration missing ${column}`);
assert.doesNotMatch(migration, /UPDATE\s+public\.bookings/i, 'Historical bookings must not be backfilled as accepted');
assert.match(migration, /VALUES \(65, 'customer_legal_consent'\)/);

assert.equal(CONTRACTOR_AGREEMENT_VERSION, '2026-08-16');
const agreementMigration = read('api/migrations/066_contractor_agreement_2026_08_16.sql');
assert.match(agreementMigration, /migration_number = 65/);
for (const functionName of [
  'guard_easer_current_agreement_online',
  'guard_booking_easer_closure_assignment',
  'guard_dispatch_offer_easer_readiness',
]) assert.ok(agreementMigration.includes(functionName), `Agreement migration missing ${functionName}`);
assert.match(agreementMigration, /v_new_version CONSTANT TEXT := '2026-08-16'/);
assert.match(agreementMigration, /DISABLE TRIGGER profiles_guard_self_update/);
assert.match(agreementMigration, /ENABLE TRIGGER profiles_guard_self_update/);
assert.match(agreementMigration, /SET is_available = FALSE/);
assert.doesNotMatch(agreementMigration, /application_status\s*=/);
assert.doesNotMatch(agreementMigration, /status\s*=/);

const terms = read('terms.html');
assert.match(terms, /AAA\) Consumer Arbitration Rules/);
assert.doesNotMatch(terms, /AAA\) Commercial Arbitration Rules/);
assert.match(terms, /Nothing in these Terms limits a lawful right to dispute a card transaction/);
assert.match(terms, /provide a separate disclosure and obtain the required written authorization/);
assert.match(terms, /Identity verification is not a representation that a full background check has been completed/);
assert.match(terms, /AssembleCash is promotional future-booking credit/);
assert.match(terms, /Direct, On-Site, and Partial Payments/);
assert.match(terms, /eligible individual small-claims action/);

const contractorAgreement = read('assembler/contractor-agreement.html');
assert.match(contractorAgreement, /Identity Verification and Background Requirements/);
assert.match(contractorAgreement, /This Agreement gives notice that screening may be required/);
assert.match(contractorAgreement, /standalone disclosure or authorization required by the Fair Credit Reporting Act/);
assert.match(contractorAgreement, /already earned compensation is not forfeited/);
assert.match(contractorAgreement, /active Texas coverage areas/);
assert.doesNotMatch(contractorAgreement, /Launch services are performed only at customer addresses inside the active Austin/);
assert.match(read('assembler/apply.html'), /Identity verification is required and is not a full criminal background check/);

const privacy = read('privacy.html');
for (const required of [
  'Anthropic',
  'Google Ads conversion measurement',
  'HubSpot',
  'Global Privacy Control',
  'Texas Privacy Appeal',
  'facial identifiers',
  'generally up to 30 days',
  'at least four years',
]) assert.ok(privacy.includes(required), `Privacy Notice missing ${required}`);

const cookies = read('assets/js/cookie-consent.js');
assert.match(cookies, /navigator\.globalPrivacyControl === true/);
assert.match(cookies, /ad_personalization: 'denied'/);
assert.match(cookies, /window\.openCookiePreferences/);
assert.match(cookies, /function initConsent\(\) \{[\s\S]*updateBannerCopy\(\)/);
assert.match(cookies, /cookieConsentBound/);

const chatApi = read('api/chat.js');
assert.match(chatApi, /SITE_CHAT_RETENTION_DAYS = 30/);
assert.match(chatApi, /\.delete\(\)[\s\S]*SITE_CHAT_EVENT_USER/);
assert.match(read('index.html'), /Messages are processed by our AI provider/);

const ignoredDirs = new Set(['.git', 'node_modules', 'tmp']);
const htmlFiles = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) walk(path);
    else if (name.endsWith('.html')) htmlFiles.push(path);
  }
}
walk(ROOT);
const directHubspot = htmlFiles
  .filter((path) => /id=["']hs-script-loader["']/i.test(readFileSync(path, 'utf8')))
  .map((path) => relative(ROOT, path));
assert.deepEqual(directHubspot, [], `HubSpot must load only after consent; direct loaders remain: ${directHubspot.join(', ')}`);

console.log('PASS legal consent, privacy, identity/background, AI, cookie, and direct-booking checks');
