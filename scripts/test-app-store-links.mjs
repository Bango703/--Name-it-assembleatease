#!/usr/bin/env node
// Both iPhone apps are offered the way Apple asks, on the pages and emails that
// matter (owner, 2026-11-11: "must look professional").
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { APP_STORE, APPLE_TRADEMARK_CREDIT, appStoreBadgeEmailHtml } from '../api/_app-store.js';
import { bannerAppFor, withBanner } from './app-banner-sync.mjs';
import { buildPublicFooter } from './lib/public-footer.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Apple's own badge, unmodified.
const svg = readFileSync(new URL('../images/badges/download-on-the-app-store.svg', import.meta.url));
assert.equal(createHash('sha256').update(svg).digest('hex'), 'a26fc5b38380272c92e9019a2eb8b45542a66814b3e2b203772db8904b9fb99f', 'the badge is the file Apple publishes');
assert.equal(APP_STORE.customer.id, '6822339934');
assert.equal(APP_STORE.easer.id, '6820654960');
for (const app of Object.values(APP_STORE)) assert.ok(app.url.endsWith(`/id${app.id}`), app.url);

// iPhone banner: the right app on the right pages, never the owner dashboard or the agreement.
assert.equal(bannerAppFor('index.html'), 'customer');
assert.equal(bannerAppFor('book.html'), 'customer');
assert.equal(bannerAppFor('blog/index.html'), 'customer');
assert.equal(bannerAppFor('assembler/my-assignments.html'), 'easer');
assert.equal(bannerAppFor('become-an-easer.html'), 'easer');
assert.equal(bannerAppFor('auth/login.html'), 'easer');
assert.equal(bannerAppFor('owner/index.html'), null);
assert.equal(bannerAppFor('assembler/contractor-agreement.html'), null);
assert.equal(withBanner('<head>\n  <meta name="viewport" content="x">\n</head>', 'customer'),
  '<head>\n  <meta name="viewport" content="x">\n  <meta name="apple-itunes-app" content="app-id=6822339934">\n</head>');
assert.equal(withBanner(withBanner('<head><meta name="viewport" content="x"></head>', 'easer'), 'easer').match(/apple-itunes-app/g).length, 1, 'never twice');
execFileSync(process.execPath, [new URL('./app-banner-sync.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--check'], { stdio: 'inherit' });
console.log('PASS banner: customer pages offer the customer app, Easer pages the Easer app');

// Footer: one customer-app badge with Apple's credit; none on Easer pages.
{
  const footer = buildPublicFooter({ variant: 'booking_resources', tagline: 'x' });
  assert.equal((footer.match(/download-on-the-app-store\.svg/g) || []).length, 1, 'one badge per layout');
  assert.ok(footer.includes(APP_STORE.customer.url));
  assert.ok(footer.includes(APPLE_TRADEMARK_CREDIT));
  assert.ok(!buildPublicFooter({ variant: 'booking_resources', tagline: 'x', appBadge: null }).includes('apps.apple.com'));
  assert.match(read('index.html'), /class="footer-app app-store-promo" href="https:\/\/apps\.apple\.com\/us\/app\/assembleatease-assembly-pros\/id6822339934"/);
  assert.doesNotMatch(read('become-an-easer.html'), /assembleatease-assembly-pros/, 'no customer app on the Easer page');
}
console.log('PASS footer: the customer app on every public page, credited; not on Easer pages');

// Booking confirmation, Easer recruiting page, and the two emails.
{
  const book = read('book.html');
  assert.match(book, /<div id="confirm-app"[\s\S]*?href="https:\/\/apps\.apple\.com\/us\/app\/assembleatease-assembly-pros\/id6822339934"[\s\S]*?App Store is a service mark of Apple Inc\./);
  const recruit = read('become-an-easer.html');
  assert.ok(recruit.includes(`href="${APP_STORE.easer.url}"`) && recruit.includes('App Store is a service mark of Apple Inc.'));
  assert.match(read('api/booking.js'), /\$\{appStoreBadgeEmailHtml\('customer', 'Track your booking and message your pro in the app\.'\)\}/);
  assert.match(read('api/assembler/update.js'), /\$\{appStoreBadgeEmailHtml\('easer', 'On iPhone, work your jobs in the Easer app\.'\)\}/);
  const email = appStoreBadgeEmailHtml('easer', 'x');
  assert.ok(email.includes(APP_STORE.easer.url) && email.includes('download-on-the-app-store.png'), 'emails use the PNG: mail apps do not show SVG');
  assert.ok(email.includes('height="40"'));
}
console.log('PASS pages and emails: booking confirmation, recruiting page, confirmation and approval emails');
console.log('\nApp Store links tests passed.');
