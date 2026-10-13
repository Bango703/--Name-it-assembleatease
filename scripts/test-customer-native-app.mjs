#!/usr/bin/env node
// AssembleAtEase customer iPhone app, 2026-10-13. Owner: "work on the customer
// as well ... both on Apple, like how the Easer currently works so we can build
// simultaneously ... they both will be completely separate apps".
//
// Nothing compiles Swift here; Codemagic does. This guard holds the contract:
//   - two separate apps, one shared folder both compile, no second copy of it
//   - every endpoint and server field the customer app reads exists by that name
//   - the app renders server answers (status words, prices, what may change)
//   - App Store basics: account deletion in the app, privacy manifest, its own bundle ID

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { customerPaymentSummary } from '../api/booking/_customer-payment-summary.js';

const read = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '');
const dir = (d) => Object.fromEntries(readdirSync(d).filter(f => f.endsWith('.swift')).map(f => [f, read(`${d}/${f}`)]));
const customer = dir('mobile/ios/Customer/Customer');
const easer = dir('mobile/ios/App/App');
const shared = dir('mobile/ios/Shared');
const app = Object.values(customer).join('\n');

// ── 1. Two apps, one shared folder ───────────────────────────────────────────
{
  const project = read('mobile/ios/Customer/project.yml');
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER: com\.assembleatease\.customer/, 'its own bundle ID, never the Easer one');
  assert.match(project, /- path: \.\.\/Shared/, 'the customer app compiles the shared folder');
  assert.match(project, /- path: \.\.\/App\/App\/Assets\.xcassets/, 'the one real logo and icon');
  assert.match(read('mobile/ios/Customer/Support/Info.plist'), /<key>CFBundleDisplayName<\/key>\s*<string>AssembleAtEase<\/string>/);
  assert.ok(existsSync('mobile/ios/Customer/Support/PrivacyInfo.xcprivacy'), 'privacy manifest');
  const pbx = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
  for (const file of Object.keys(shared)) {
    assert.ok(pbx.includes(`path = ../Shared/${file}; sourceTree = SOURCE_ROOT;`), `the Easer app compiles Shared/${file}`);
    assert.ok(pbx.includes(`/* ${file} in Sources */,`), `Shared/${file} is in the Easer build`);
  }
  for (const [name, files] of [['customer', customer], ['easer', easer]]) {
    const text = Object.values(files).join('\n');
    for (const type of ['enum Brand', 'enum InAppBrowser', 'enum SessionVault', 'enum Format', 'struct DynamicKey', 'struct AppSession', 'class APIClient', 'struct AppError']) {
      assert.ok(!text.includes(type + ' ') && !text.includes(type + ':'), `${name} app keeps no second copy of ${type}`);
    }
  }
  const codemagic = read('codemagic.yaml');
  assert.match(codemagic, /customer-ios:[\s\S]*bundle_identifier: com\.assembleatease\.customer[\s\S]*xcodegen generate[\s\S]*--scheme Customer/, 'its own Codemagic workflow');
  assert.match(codemagic, /easer-ios:[\s\S]*bundle_identifier: com\.assembleatease\.easer/, 'the Easer workflow is unchanged');
  assert.match(read('.gitignore'), /mobile\/ios\/Customer\/Customer\.xcodeproj\//, 'the generated project is not committed');
  assert.doesNotMatch(app, /\/api\/assembler\/|EaserStore|EaserAPI|EaserViews/, 'nothing Easer-side in the customer app');
}

// ── 2. Every endpoint the app calls exists ───────────────────────────────────
{
  const paths = [...app.matchAll(/"(\/api\/[a-z0-9/_-]+)/g)].map(m => m[1]);
  assert.ok(paths.length >= 8, `found ${paths.length} endpoints`);
  for (const path of new Set(paths)) assert.ok(existsSync(`.${path}.js`), `${path} exists`);
}

// ── 3. Every server field the app reads exists, under that name ──────────────
{
  const models = customer['CustomerModels.swift'];
  const list = read('api/booking/customer-bookings.js');
  for (const field of ['id', 'ref', 'service', 'date', 'time', 'address', 'status', 'customer_status', 'customer_status_detail', 'pro_first_name']) {
    assert.ok(list.includes(`${field}:`) && models.includes(`"${field}"`), `list field ${field}`);
  }
  const track = read('api/booking/track.js');
  for (const field of ['customer_status', 'customer_status_detail', 'pro_first_name', 'pro_photo', 'pro_rating', 'pro_jobs', 'pro_verified',
    'completion_photo_url', 'message_recipient', 'cancellation_preview', 'easer_time_proposal', 'items', 'reschedule_options', 'can_reschedule', 'address', 'city']) {
    assert.ok(new RegExp(`\\b${field}\\b[,:]`).test(track) && models.includes(`"${field}"`), `booking field ${field}`);
  }
  assert.match(track, /safe\.payment_summary = customerPaymentSummary\(safe\)/);
  assert.match(models, /"payment_summary"/);
  for (const field of ['total_label', 'total_cents', 'rows', 'note', 'label', 'cents', 'strong']) {
    assert.ok(read('api/booking/_customer-payment-summary.js').includes(field) && models.includes(`"${field}"`), `price field ${field}`);
  }
  for (const field of ['fee_cents', 'message']) assert.ok(read('api/booking/_cancellation-fee-summary.js').includes(`${field}:`) && models.includes(`"${field}"`), `cancel preview ${field}`);
  for (const field of ['slots', 'window_days']) assert.ok(track.includes(field) && models.includes(`"${field}"`), `reschedule option ${field}`);
  for (const field of ['name', 'quantity', 'isAddOn', 'addOnName', 'lineTotalCents']) {
    assert.ok(read('api/booking/_booking-items.js').includes(field) && models.includes(`"${field}"`), `item field ${field}`);
  }
  assert.ok(read('api/booking/customer-photos.js').includes('signed_url') && models.includes('"signed_url"'));
  assert.ok(read('api/booking/_time-proposals.js').length && /date: openProposal\.proposed_date, time: openProposal\.proposed_time/.test(track));
}

// ── 4. The server decides; the app renders ───────────────────────────────────
{
  const views = customer['CustomerViews.swift'];
  assert.doesNotMatch(app, /Text\((booking|detail)\.status\)/, 'no raw status code in front of a customer');
  assert.doesNotMatch(app, /tax_amount|service_call_fee|amount_charged/, 'no price math in the app');
  assert.match(views, /if detail\.canReschedule \{/, 'reschedule follows the server');
  assert.match(views, /if detail\.canCancel \{/, 'cancel follows the server');
  assert.match(customer['CustomerModels.swift'], /var canCancel: Bool \{ cancellation != nil \}/);
  assert.match(views, /Text\(detail\?\.cancellation\?\.message \?\? ""\)/, 'the cancel warning is the server\'s, the same one the fee is charged by');
  assert.match(customer['CustomerAPI.swift'], /"proposalId"/, "accepting the pro's time keeps the pro and the cancellation terms (reschedule.js)");
  assert.match(customer['CustomerAPI.swift'], /PhotoPrep\.jpeg\(from: image\)/, 'photos are sized by the shared rule');

  // The price breakdown (api/booking/_customer-payment-summary.js) adds up.
  const paid = customerPaymentSummary({ total_price: 15400, amount_charged: 16671, tax_amount: 1271, service_call_fee: 500, payment_status: 'captured' });
  assert.equal(paid.total_label, 'Total Charged');
  assert.deepEqual(paid.rows.map(r => r.cents), [14900, 500, 1271]);
  assert.equal(paid.rows.reduce((s, r) => s + r.cents, 0), paid.total_cents, 'the rows add up to the total');
  const refunded = customerPaymentSummary({ amount_charged: 10000, tax_amount: 0, refund_amount: 2500, payment_status: 'partially_refunded' });
  assert.deepEqual(refunded.rows.slice(-2).map(r => r.cents), [-2500, 7500]);
  assert.equal(customerPaymentSummary({ total_price: 0 }).rows.length, 0, 'nothing to break down, nothing shown');
  const track = read('track.html');
  assert.match(track, /var summary = b\.payment_summary/, 'the booking page renders the same breakdown');
  assert.doesNotMatch(track, /var serviceItems = Math\.max\(0, total - tax - call\)/, 'the page no longer does its own price math');
}

// ── 5. App Store basics ──────────────────────────────────────────────────────
{
  const views = customer['CustomerViews.swift'];
  assert.match(views, /Button\("Delete account", role: \.destructive\)/, 'an account made in the app can be deleted in the app (5.1.1(v))');
  assert.match(customer['CustomerAPI.swift'], /call\("DELETE", "\/api\/customer\/account"\)/);
  assert.match(read('api/customer/account.js'), /sb\.auth\.admin\.deleteUser\(user\.id\)/);
  assert.match(read('api/customer/account.js'), /STAFF_ROLES\.has/, "an Easer's account is never deleted from the customer app");
  assert.match(views, /\.textContentType\(\.oneTimeCode\)/, 'the code fills from the email suggestion');
  assert.doesNotMatch(app, /SecureField|signIn\(email: [^,]+, password/, 'no password to remember');
}

console.log('PASS customer native app: separate app with its own bundle ID and workflow, shared code compiled by both, every endpoint and field matches the server, prices and permissions from the server, in-app account deletion.');
