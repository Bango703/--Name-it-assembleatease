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

// ── 4b. Every field a screen reads exists on its model (build 2 failed on
// detail.isPast after the model lost it; nothing here compiles Swift) ─────────
{
  const models = customer['CustomerModels.swift'];
  const views = Object.values(customer).join('\n');
  const block = (name) => {
    const start = models.indexOf(`struct ${name}:`);
    const next = models.indexOf('\nstruct ', start + 1);
    return models.slice(start, next < 0 ? undefined : next);
  };
  for (const [variable, type] of [['detail', 'BookingDetail'], ['booking', 'BookingSummary'], ['proposal', 'ProposedTime'], ['payment', 'PaymentSummary'], ['message', 'CustomerMessage']]) {
    const body = block(type);
    assert.ok(body.length > 0, `${type} exists`);
    const used = new Set([...views.matchAll(new RegExp(`\\b${variable}\\??\\.([a-zA-Z]+)`, 'g'))].map(m => m[1]));
    assert.ok(used.size > 0, `${variable} is read somewhere`);
    for (const member of used) {
      assert.ok(new RegExp(`(let|var) ${member}\\b`).test(body), `${type} has ${member} (used as ${variable}.${member})`);
    }
  }
}

// ── 4c. Booking in the app (owner, 2026-10-13: "booking still goes through
// website"). The server owns the catalog, the total, how it is paid and every
// refusal; the app builds the order by item name and hands cards to Stripe. ───
{
  const flow = customer['CustomerBooking.swift'];
  const models = customer['CustomerModels.swift'];
  const catalogApi = read('api/booking/catalog.js');
  const bookingApi = read('api/booking.js');
  const preview = read('api/booking/promo-preview.js');

  // One catalog: the endpoint reads the same file the server prices against.
  assert.match(catalogApi, /getBookingCatalog\(\)/, 'the catalog is the pricing catalog');
  for (const field of ['price_cents', 'add_on', 'custom_quote', 'popular', 'today_open_slots', 'first_date', 'last_date', 'terms_version', 'privacy_notice_version']) {
    assert.ok(catalogApi.includes(field) && models.includes(`"${field}"`), `catalog field ${field}`);
  }

  // The windows offered are exactly the ones a new booking accepts.
  const { BOOKING_TIME_SLOTS, openBookingSlots } = await import('../api/booking/_booking-slots.js');
  const allowed = bookingApi.match(/const allowedSlots = \[([\s\S]*?)\];/);
  assert.ok(allowed, 'api/booking.js still checks allowedSlots');
  assert.deepEqual([...allowed[1].matchAll(/'([^']+)'/g)].map(m => m[1]), [...BOOKING_TIME_SLOTS], 'catalog windows match what a booking accepts');
  assert.deepEqual(openBookingSlots('2026-10-13', new Date('2026-10-14T05:30:00Z')), [], 'a day that has passed offers nothing');
  assert.equal(openBookingSlots('2026-10-20', new Date('2026-10-14T05:30:00Z')).length, BOOKING_TIME_SLOTS.length);

  // The total and the plan come from the server; the website's call is unchanged without a date.
  assert.match(preview, /summary: checkoutSummary\(pricingWithPromo, promo\)/);
  assert.match(preview, /plan: checkoutPlan\(/);
  assert.match(preview, /appointmentDate \? sameDayFeeForAppointment\(appointmentDate\) : 0/, 'no date, no same-day fee: the website preview behaves as before');
  const { checkoutSummary, checkoutPlan } = await import('../api/booking/_checkout.js');
  const { calculateBookingPricing } = await import('../api/_pricing.js');
  const priced = calculateBookingPricing({
    services: ['Furniture Assembly', 'Mounting & Hanging'],
    itemsByService: {
      'Furniture Assembly': [{ name: 'Bed frame — queen', qty: 2 }, { name: 'Dresser (up to 6 drawers)', qty: 1 }],
      'Mounting & Hanging': [{ name: 'TV 41"–55" (standard wall)', qty: 1 }],
    },
    zip: '78701',
  });
  const summary = checkoutSummary({ ...priced, promoDiscountCents: 0 }, null);
  assert.equal(summary.rows.reduce((s, r) => s + r.cents, 0), summary.total_cents, 'the rows add up to the total');
  assert.equal(summary.total_cents, priced.totalCents);
  assert.equal(checkoutPlan({ totalCents: 0, hasCustomQuote: true, date: '2026-10-20' }).kind, 'quote');
  assert.equal(checkoutPlan({ totalCents: 5000, hasCustomQuote: true, date: '2026-10-20' }).kind, 'quote', 'a custom-quote item makes the order a quote, as on the website');

  // The app never prices: it sends names and quantities, renders the server's rows and button.
  assert.doesNotMatch(flow, /priceCents\s*[*+]/, 'no price math in the app');
  assert.doesNotMatch(flow, /"price":/, 'the order carries no price');
  assert.match(flow, /"name": item\.name, "qty": qty/);
  assert.match(flow, /flow\.preview\?\.plan\?\.button/, 'the button is the server\'s');
  assert.match(flow, /ForEach\(Array\(summary\.rows\.enumerated\(\)\)/, 'the total is the server\'s rows');
  assert.match(flow, /order\["termsVersion"\] = catalog\?\.termsVersion/, 'the Terms version is the server\'s current one');
  assert.match(flow, /order\["promoPreviewTotalCents"\]/, 'a changed offer is caught by the server (PROMO_CHANGED)');
  assert.match(flow, /Optional: Text me appointment and service updates from AssembleAtEase at the number above\. Message frequency varies\. Message and data rates may apply\. Consent is not a condition of purchase\. Reply STOP to opt out or HELP for help\./,
    'the text-message consent words are the website\'s, word for word');
  assert.ok(read('book.html').includes('Optional: Text me appointment and service updates from AssembleAtEase at the number above.'), 'and the website still says them');
  // A retry reuses the booking it already made instead of minting another (book.html does the same).
  assert.match(flow, /held\.fingerprint == orderPrint/);
  // A card hold that went through is confirmed without asking the customer again (Rule 16).
  assert.match(flow, /await confirm\(created\)/);

  // Cards go to Stripe's sheet, over the server's client secret.
  const payments = customer['CustomerPayments.swift'];
  assert.match(payments, /PaymentSheet\(paymentIntentClientSecret: secret/);
  assert.match(payments, /PaymentSheet\(setupIntentClientSecret: secret/);
  const project = read('mobile/ios/Customer/project.yml');
  assert.match(project, /url: https:\/\/github\.com\/stripe\/stripe-ios-spm/);
  assert.match(project, /product: StripePaymentSheet/);
  const plist = read('mobile/ios/Customer/Support/Info.plist');
  const scheme = payments.match(/returnURL = "([a-z-]+):\/\//)?.[1];
  assert.ok(scheme && plist.includes(`<string>${scheme}</string>`), 'the bank-verification return link is registered');
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>/, 'card scanning has its permission line');
  assert.doesNotMatch(easer.toString() + Object.values(easer).join('\n'), /import Stripe/, 'the Easer app takes no payments');
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
