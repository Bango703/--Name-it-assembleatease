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
  // Customer apps carry the brand name; worker apps a role name (Uber/Driver, DoorDash/Dasher,
  // Instacart/Shopper, Taskrabbit/Tasker). "AssembleAtEase" was cut off under the icon.
  assert.match(read('mobile/ios/Customer/Support/Info.plist'), /<key>CFBundleDisplayName<\/key>\s*<string>Assemble<\/string>/);
  assert.match(read('mobile/ios/App/App/Info.plist'), /<key>CFBundleDisplayName<\/key>\s*<string>Easer<\/string>/);
  // Same AAE monogram, two backdrops (Thumbtack and Thumbtack Pro): the customer icon is the
  // brand's, the Easer icon the dark one. The monogram file itself is untouched.
  assert.match(project, /ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon/);
  const easerProject = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
  assert.equal((easerProject.match(/ASSETCATALOG_COMPILER_APPICON_NAME = EaserIcon;/g) || []).length, 2, 'the Easer app uses its own icon in both configurations');
  assert.ok(existsSync('mobile/ios/App/App/Assets.xcassets/EaserIcon.appiconset/EaserIcon-1024.png'));
  assert.ok(existsSync('mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
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
  assert.match(preview, /summary: checkoutSummary\(pricingWithPromo, promo, assemblecash\)/);
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

// ── 4d. Home, not a booking list (owner, 2026-10-13: "customer lands on booking ... seems
// basic"). The progress a booking shows is the server's, in the list and when opened. ─
{
  const appSource = read('mobile/ios/Customer/Customer/CustomerApp.swift');
  assert.ok(appSource.indexOf('HomeView()') > 0 && appSource.indexOf('HomeView()') < appSource.indexOf('ActivityView()'), 'Home is the first tab');
  // Three tabs, one job each (owner, 2026-10-14: "home and services double talk"): Home finds
  // and books, Activity follows what was booked and the messages about it, Account is the person.
  assert.equal((appSource.match(/\.tabItem \{/g) || []).length, 3, 'three tabs');
  assert.doesNotMatch(appSource, /ServicesView\(\)|InboxView\(\)|BookingsView\(\)/, 'no second catalog tab, no separate inbox tab');
  const homeSource = read('mobile/ios/Customer/Customer/CustomerHome.swift');
  const viewsSource = read('mobile/ios/Customer/Customer/CustomerViews.swift');
  assert.doesNotMatch(homeSource, /ForEach\(store\.(upcoming|past|bookings)/, 'Home does not list bookings; Activity does');
  assert.doesNotMatch(viewsSource, /SearchBox|ServicesGrid|BundleCard/, 'Activity and Account do not repeat the catalog');
  assert.equal((homeSource.match(/SearchBox \{/g) || []).length, 1, 'one search box in the app');
  assert.match(read('mobile/ios/Customer/Customer/CustomerStore.swift'), /@Published var tab: CustomerTab = \.home/, 'the app opens on Home');
  const { customerProgress, CUSTOMER_PROGRESS_STEPS } = await import('../api/booking/_customer-status.js');
  assert.equal(customerProgress({ status: 'confirmed' }).step, 0);
  assert.equal(customerProgress({ status: 'confirmed', assembler_accepted_at: 'x' }).step, 1);
  assert.equal(customerProgress({ status: 'en_route', assembler_accepted_at: 'x' }).step, 2);
  assert.equal(customerProgress({ status: 'in_progress' }).step, 3);
  assert.equal(customerProgress({ status: 'completed' }).step, CUSTOMER_PROGRESS_STEPS.length - 1);
  assert.equal(customerProgress({ status: 'cancelled' }), null, 'nothing to track on a cancelled booking');
  for (const file of ['api/booking/customer-bookings.js', 'api/booking/track.js']) {
    assert.match(read(file), /customer_progress: customerProgress\(/, `${file} sends the progress`);
  }
  assert.match(customer['CustomerModels.swift'], /"customer_progress"/);
  assert.match(read('api/booking/catalog.js'), /from_cents: fromCents\(groups\)/, '"From $X" comes from the catalog');
  assert.match(customer['CustomerModels.swift'], /"from_cents"/);
  assert.match(customer['CustomerHome.swift'], /TextField\("What do you need help with\?", text: \$query\)/, 'search on Home');
  assert.match(customer['CustomerViews.swift'], /ProgressTracker\(progress: progress\)/, 'the tracker on every upcoming booking and on the booking page');
  assert.doesNotMatch(customer['CustomerHome.swift'], /status == "(en_route|arrived|in_progress)"/, 'the app does not work out the step itself');
}

// ── 4e. Notifications, lock-screen tracker, AssembleCash, Inbox (owner, 2026-10-13).
{
  const { liveActivityState, customerPushCopy } = await import('../api/_customer-push.js');
  const attributes = read('mobile/ios/Customer/LiveShared/BookingActivityAttributes.swift');
  const state = liveActivityState({ status: 'en_route', assembler_accepted_at: 'x', assembler_name: 'Trapper Jones', time: '10:00 AM – 12:00 PM' });
  for (const key of Object.keys(state)) {
    assert.match(attributes, new RegExp(`var ${key}: `), `the tracker's ${key} is a field the lock screen reads`);
  }
  assert.equal(state.step, 2);
  assert.equal(state.proName, 'Trapper', 'first name only on the lock screen');
  assert.equal(customerPushCopy('cancelled', {}), null, 'a cancellation the customer made sends no notification');
  for (const [file, event] of [
    ['api/booking/accept-dispatch.js', "'accepted'"],
    ['api/booking/easer-status.js', 'stage'],
    ['api/booking/assembler-complete.js', "'completed'"],
    ['api/booking/message.js', "'message'"],
    ['api/booking/guest-cancel.js', "'cancelled'"],
    ['api/booking/customer-cancel.js', "'cancelled'"],
    ['api/booking/cancel.js', "'cancelled'"],
  ]) {
    assert.ok(read(file).includes(`notifyCustomerApp(sb, `) && read(file).includes(event), `${file} tells the customer app (${event})`);
  }
  assert.match(read('api/_customer-push.js'), /export async function notifyCustomerApp[\s\S]*catch \(e\)/, 'a push failure never fails the booking action');
  assert.ok(existsSync('api/migrations/111_customer_app_push.sql'));

  // AssembleCash: the total shown is the total held.
  const { totalsAfterAssembleCash } = await import('../api/_assemblecash.js');
  assert.deepEqual(totalsAfterAssembleCash({ promoAdjustedItemSubtotalCents: 23800, serviceCallFeeCents: 500, sameDayFeeCents: 0, redeemCents: 2000 }),
    { taxableSubtotalCents: 22300, taxCents: 1840, totalCents: 24140 });
  assert.equal((read('api/booking.js').match(/totalsAfterAssembleCash\(/g) || []).length, 2, 'the booking charges with the shared calculation');
  assert.match(read('api/booking/promo-preview.js'), /totals: totalsAfterAssembleCash\(/, 'the preview shows it with the same one');
  assert.doesNotMatch(read('api/booking.js'), /promoAdjustedItemSubtotalCents - reservedRedeem/, 'no second copy of the math in the booking');
  assert.match(read('api/customer/account.js'), /issueRedemptionToken\(email\)/);
  assert.match(customer['CustomerBooking.swift'], /"assemblecashToken": assemblecashToken \?\? ""/);

  // Inbox and Bookings list the same bookings.
  assert.match(read('api/customer/inbox.js'), /customerAccountBookings\(/);
  assert.match(read('api/booking/customer-bookings.js'), /customerAccountBookings\(/);

  // Home: one search box, at most one suggestion; the catalog on Services.
  const home = customer['CustomerHome.swift'];
  assert.match(home, /SearchBox \{ searching = true \}/);
  assert.match(home, /private var pick: Pick\?/, 'one suggestion, chosen in one place');
  assert.match(read('mobile/ios/Customer/Customer/CustomerApp.swift'), /HomeView\(\)[\s\S]*ActivityView\(\)[\s\S]*CustomerAccountView\(\)/);
  const project = read('mobile/ios/Customer/project.yml');
  assert.match(project, /CustomerLiveActivity:[\s\S]*PRODUCT_BUNDLE_IDENTIFIER: com\.assembleatease\.customer\.live/, 'the tracker extension shares the app prefix (Codemagic signs com.assembleatease.customer.*)');
  assert.match(project, /product: FirebaseMessaging/);
  assert.match(read('mobile/ios/Customer/Support/Customer.entitlements'), /aps-environment/);
  assert.match(read('mobile/ios/Customer/Support/Info.plist'), /<key>NSSupportsLiveActivities<\/key>\s*<true\/>/);
}

// ── 4f. Owner audit, 2026-10-14: an unfinished card checkout read as a booking;
// the booking page was a five-line list; Home needed real work on it. ──────────
{
  const { customerCheckoutUnfinished } = await import('../api/booking/_customer-status.js');
  assert.equal(customerCheckoutUnfinished({ status: 'pending', payment_status: 'pending', stripe_payment_intent_id: 'pi_1' }), true, 'card never held: not a booking to the customer');
  assert.equal(customerCheckoutUnfinished({ status: 'pending', payment_status: 'failed', stripe_payment_intent_id: 'pi_1' }), true);
  assert.equal(customerCheckoutUnfinished({ status: 'confirmed', payment_status: 'authorized', stripe_payment_intent_id: 'pi_1' }), false);
  assert.equal(customerCheckoutUnfinished({ status: 'pending', payment_status: 'card_saved' }), false, 'a quote with a saved card is a real request');
  assert.equal(customerCheckoutUnfinished({ status: 'confirmed', payment_status: 'card_saved' }), false, 'a future booking with a saved card is real');
  const list = read('api/booking/customer-bookings.js');
  assert.match(list, /owned\.filter\(b => !customerCheckoutUnfinished\(b\)\)/, 'the customer list leaves unfinished checkouts out');
  assert.match(list, /stripe_payment_intent_id'/, 'and reads the field the rule needs');

  // One real job photo per service, each used once, each file present.
  const catalogSource = read('api/booking/catalog.js');
  const photos = [...catalogSource.matchAll(/'(\/images\/real-[^']+)'/g)].map(m => m[1]);
  assert.equal(photos.length, 6, 'six services, six photos');
  assert.equal(new Set(photos).size, photos.length, 'no photo used twice');
  for (const photo of photos) assert.ok(existsSync('.' + photo), `${photo} exists`);
  assert.match(customer['CustomerModels.swift'], /"photo"/);

  // The booking page: actions side by side, photos on their own, cancel last and quiet.
  const views = customer['CustomerViews.swift'];
  assert.doesNotMatch(views, /Need something\?/, 'no five-line action list');
  assert.match(views, /ActionTile\(symbol: "bubble\.left\.fill", title: "Message"\)/);
  assert.match(views, /private func photosCard\(/);
  assert.ok(views.indexOf('if detail.canCancel {') > views.indexOf('paymentCard(payment)'), 'cancel sits below the booking, not among the everyday actions');
}

// ── 4g. Both apps together (owner, 2026-10-14: a customer messaged the pro on a
// finished job and the pro's app had nowhere to read it; customers could not
// rate their pro). Every hand-off between the two apps has a sender and a reader.
{
  const { customerMessageRecipient } = await import('../api/booking/_message-routing.js');
  const accepted = { assembler_id: 'e1', assembler_accepted_at: 'x' };
  assert.equal(customerMessageRecipient({ ...accepted, status: 'en_route' }), 'assembler', 'during the job the customer talks to the pro');
  for (const status of ['completed', 'cancelled', 'declined', 'refunded']) {
    assert.equal(customerMessageRecipient({ ...accepted, status }), 'owner', `after ${status} the customer writes to AssembleAtEase`);
  }
  const easerViews = read('mobile/ios/App/App/EaserViews.swift');
  assert.match(easerViews, /if job\.acceptedAt != nil && job\.isFinished \{\s*DetailBlock\(title: "Messages"\)/, 'a finished job still shows its conversations to the Easer');
  assert.match(easerViews, /if thread == \.customer && job\.isFinished \{/, 'and the customer thread of a finished job reads, it does not send');

  // Reviews and tips: the app is a second door to the same endpoints.
  const review = read('api/review.js');
  assert.match(review, /const viaApp = !token && usesCustomerAccount\(req\)/);
  assert.match(review, /customerOwnsBooking\(booking, appCustomer\)/, 'only the owner of the booking reviews it from the app');
  assert.match(review, /notificationType: 'customer_review', recipientType: 'easer'/, 'the Easer hears about a review');
  const tip = read('api/booking/tip.js');
  assert.match(tip, /const viaApp = !token && usesCustomerAccount\(req\)/);
  assert.match(tip, /stripeAccount: accountId/, 'a tip is still created on the Easer\'s own account');
  assert.match(tip, /notificationType: 'customer_tip', recipientType: 'easer'/, 'the Easer hears about a tip once Stripe confirms it');
  assert.match(read('api/booking/track.js'), /safe\.review = /);
  assert.match(customer['CustomerModels.swift'], /"can_review"/);
  assert.match(customer['CustomerPayments.swift'], /client\.stripeAccount = stripeAccount/, 'the tip sheet pays the Easer\'s account');

  // Extra work: the pro asks in the Easer app, the customer answers in theirs, the pro hears back.
  const approve = read('api/booking/change-order-approve.js');
  assert.match(approve, /const viaApp = !token && usesCustomerAccount\(req\)/);
  assert.equal((approve.match(/stripe\.paymentIntents\.create\(/g) || []).length, 1, 'one authorization path for both doors');
  assert.match(approve, /approval_token_hash: changeOrder\.approval_token_hash/, 'a failed card puts back the email link that existed');
  assert.match(approve, /notificationType: 'change_order_approved', recipientType: 'easer'/);
  assert.match(approve, /notificationType: 'change_order_declined', recipientType: 'easer'/);
  assert.match(read('api/booking/track.js'), /safe\.change_orders = /);
  assert.match(customer['CustomerModels.swift'], /"change_orders"/);

  // Every Easer notice sent about these has words in the Easer inbox.
  const catalog = read('api/assembler/notifications.js');
  for (const type of ['customer_review', 'customer_tip', 'change_order_approved', 'change_order_declined']) {
    assert.match(catalog, new RegExp(`${type}: notice\\(`), `the Easer inbox explains ${type}`);
  }

  // When the pro needs the customer, the customer's phone hears it too.
  const { customerPushCopy } = await import('../api/_customer-push.js');
  for (const event of ['time_proposed', 'not_home', 'extra_work']) {
    assert.ok(customerPushCopy(event, { assembler_name: 'Trapper Jones' }, { description: 'Wall anchor' }), `${event} has words`);
  }
  assert.match(read('api/booking/time-proposal.js'), /notifyCustomerApp\(sb, booking\.id, 'time_proposed'\)/);
  assert.match(read('api/booking/customer-unavailable.js'), /notifyCustomerApp\(sb, booking\.id, 'not_home'\)/);
  assert.match(read('api/booking/_change-order-request.js'), /notifyCustomerApp\(sb, booking\.id, 'extra_work'/);
  // When the customer changes the job, the Easer's phone hears it, not only their email.
  for (const file of ['api/booking/guest-cancel.js', 'api/booking/customer-cancel.js']) {
    assert.match(read(file), /notificationType: 'easer_job_cancelled', recipientType: 'easer' \}\)/, `${file} pushes the cancellation to the Easer`);
  }
  assert.match(read('api/booking/reschedule.js'), /notificationType: 'reschedule_easer_reconfirmation', recipientType: 'easer' \}\)/);
  assert.match(read('api/booking/reschedule.js'), /notificationType: 'easer_time_proposal_accepted', recipientType: 'easer' \}\)/);
}

// ── 4h. One chat in both apps (owner, 2026-10-14: "the chat system for easer and
// customer dash can be better"; the Office and Fitness tiles drew over each other).
// "Seen" is the server's read_at, never a guess; the inbox names the recipient the
// server routes to. ───────────────────────────────────────────────────────────
{
  const foundation = shared['AppFoundation.swift'];
  for (const part of ['struct ChatLine', 'struct ChatTranscript', 'struct ChatBubble', 'struct QuickReplies', 'struct ChatComposer']) {
    assert.ok(foundation.includes(part), `${part} lives once, in the shared folder`);
    for (const [name, src] of [...Object.entries(customer), ...Object.entries(easer)]) {
      assert.ok(!src.includes(part), `${name} keeps its own copy of ${part}`);
    }
  }
  assert.match(foundation, /lines\.last\(where: \{ \$0\.fromMe && \$0\.readAt != nil \}\)/, '"Seen" comes from read_at');
  assert.match(customer['CustomerModels.swift'], /readAt = c\.string\("read_at"\)/);
  assert.match(easer['EaserModels.swift'], /readAt = c\.string\("read_at"\)/);
  const message = read('api/booking/message.js');
  assert.ok((message.match(/read_at\)/g) || []).length >= 1 && message.includes("update({ read_at: new Date().toISOString() })"), 'opening a conversation stamps read_at');
  const views = customer['CustomerViews.swift'];
  const easerViews = easer['EaserViews.swift'];
  for (const [name, src] of [['customer', views], ['Easer', easerViews]]) {
    assert.match(src, /ChatTranscript\(/, `the ${name} app draws the shared transcript`);
    assert.match(src, /ChatComposer\(/, `the ${name} app uses the shared composer`);
    assert.match(src, /QuickReplies\(/, `the ${name} app offers quick replies`);
    assert.match(src, /Task\.sleep\(nanoseconds: 10_000_000_000\)/, `an open ${name} chat refreshes on its own`);
  }
  assert.doesNotMatch(views, /struct CustomerBubble/);
  assert.doesNotMatch(easerViews, /struct MessageBubble/);
  assert.match(easerViews, /thread == \.customer && job\.isFinished/, 'a finished job closes the Easer-to-customer composer, as message.js does');
  assert.match(read('api/customer/inbox.js'), /message_recipient: customerMessageRecipient\(booking\)/, 'the inbox names who a reply goes to');
  assert.match(customer['CustomerModels.swift'], /messageRecipient = c\.string\("message_recipient"\)/);
  assert.match(views, /conversation\.messageRecipient == "pro"/, 'an inbox conversation is titled with its real recipient');
  // Addresses (owner, 2026-10-14: "use Apple Maps ... anywhere an address has to be entered").
  // One Apple Maps search in the shared folder; every address screen in both apps uses it.
  assert.match(foundation, /final class AddressSearch: NSObject, ObservableObject, MKLocalSearchCompleterDelegate/);
  assert.match(foundation, /completer\.resultTypes = \.address/);
  const addressScreens = [
    ['booking', customer['CustomerBooking.swift']],
    ['customer details', customer['CustomerViews.swift']],
    ['Easer location', easer['EaserAccountViews.swift']],
  ];
  for (const [name, src] of addressScreens) {
    assert.match(src, /AddressSuggestionList\(search:/, `the ${name} screen fills addresses from Apple Maps`);
  }
  assert.doesNotMatch(app, /\/api\/address\/autocomplete/, 'the app has one address lookup, not two');
  // A bundle booked in the app counts as that bundle in the owner's reporting, as on the website.
  const booking = customer['CustomerBooking.swift'];
  assert.match(booking, /bundleSlug = bundle\.slug/, 'adding a bundle remembers which one');
  assert.match(booking, /order\["bundleSlug"\] = bundleSlug \?\? ""/, 'the booking carries the bundle');
  assert.match(read('book.html'), /bundleSlug: BOOK\.bundleSlug \|\| ''/, 'the website sends the same field');
  // Owner, 2026-10-14: "describe your custom quote ... then notes for your pro ... no info if I
  // put notes"; "Change items sends all the way to Home". The project is asked on the quote
  // item itself; the customer sees their notes on the booking; Change items goes to the items.
  assert.match(booking, /if item\.customQuote && flow\.quantity\(CartKey\(service: serviceName, item: item\.name\)\) > 0 \{\s*ProjectDescriptionField\(\)/, 'the description box opens on the quote item');
  assert.match(booking, /hasCustomQuote && projectDescription[\s\S]{0,80}return "Describe the project\."/, 'a quote cannot be sent without a description');
  assert.equal((booking.match(/order\["details"\] = notesForServer/g) || []).length, 2, 'the preview and the booking send the same notes');
  assert.doesNotMatch(booking, /flow\.path = \[\] \}/, 'editing the order never drops the customer on Home');
  // Owner, 2026-10-14: "can't remove items". The whole order opens from the cart bar and the
  // review step, every line with minus, plus and swipe to remove.
  assert.match(booking, /struct OrderEditor: View/);
  assert.match(booking, /Button\("Remove", role: \.destructive\) \{\s*flow\.setQuantity\(0,/);
  assert.match(booking, /Button \{ showOrder = true \}/, 'the cart bar opens the order');
  assert.match(booking, /Button\("Edit order"\) \{ editingOrder = true \}/, 'the review step opens the order');
  assert.match(read('api/booking/track.js'), /details: booking\.details \|\| null/, 'the booking returns the customer their own notes');
  assert.match(customer['CustomerViews.swift'], /CustomerBlock\(title: "Your notes for the pro"\)/);
  // Owner, 2026-10-14: "in job review notes doesn't show", then a two-sided audit. The review
  // step shows the notes and who is booking; a return visit shows in both apps.
  assert.match(booking, /CustomerBlock\(title: "Notes for your pro"\)[\s\S]{0,1600}flow\.backToDetails\(\)/, 'the review step shows the notes, with a way back to change them');
  // Owner, 2026-10-15: "sticker shock is the problem ... customer don't see price until
  // at checkout or cart". Lists, tiles, search and the season card show no price; the
  // order sheet (the cart) and checkout do. Group titles read as headings.
  const itemRow = booking.slice(booking.indexOf('struct ItemRow'), booking.indexOf('struct QuantityControl'));
  assert.match(itemRow, /var showsPrice = false/, 'an item shows no price unless asked');
  assert.match(itemRow, /if showsPrice \{\s*Text\(priceText\)/);
  assert.match(itemRow, /Text\(item\.name\)\.font\(\.body\)/, 'item names at body size');
  assert.equal((booking.match(/showsPrice: true/g) || []).length, 1, 'only the order sheet shows prices on items');
  assert.match(booking.slice(booking.indexOf('struct OrderEditor')), /ItemRow\(item: item, quantity: binding\(for: line\), showsPrice: true\)/);
  assert.match(booking, /header: \{\s*GroupHeader\(title: group\.name\)/, 'service groups use the bold heading');
  assert.match(booking, /struct GroupHeader[\s\S]{0,500}\.font\(\.title3\.weight\(\.bold\)\)[\s\S]{0,120}\.textCase\(nil\)/);
  // iOS 26 restyles custom list header fonts (2026-10-15 screenshots showed them grey).
  assert.match(booking, /GroupHeader\(title: group\.name\)\s*\}\s*\.headerProminence\(\.increased\)/, 'service groups use the large system header');
  assert.match(booking, /GroupHeader\(title: service\)\s*\}\s*\.headerProminence\(\.increased\)/, 'the order sheet does too');
  const homeFile = customer['CustomerHome.swift'];
  assert.ok(!homeFile.includes('"From "') && !homeFile.includes('From \\('), 'no From price on Home or in search');
  assert.doesNotMatch(homeFile, /showsPrice: true/, 'Home never shows item prices');

  // Owner, 2026-10-14: "at checkout can't edit when and where".
  const whenWhere = booking.slice(booking.indexOf('CustomerBlock(title: "When and where")'), booking.indexOf('CustomerBlock(title: "Notes for your pro")'));
  assert.match(whenWhere, /Button\("Change time"\) \{ flow\.backToSchedule\(\) \}/, 'the review step changes the time');
  assert.match(whenWhere, /Button\("Change address"\) \{ flow\.backToDetails\(\) \}/, 'the review step changes the address');
  assert.match(booking, /func backToSchedule\(\) \{\s*if let index = path\.lastIndex\(of: \.schedule\)/, 'back to the When step, keeping the order and details');
  assert.match(booking, /systemImage: "person"\)/, 'the review step shows the name and phone');
  assert.match(customer['CustomerModels.swift'], /returnVisit = c\.bool\("return_visit_required"\)/);
  assert.match(customer['CustomerViews.swift'], /CustomerBlock\(title: "Return visit"\)/, 'the customer sees the return visit, as track.html shows it');
  assert.match(easer['EaserModels.swift'], /returnVisitRemaining = c\.string\("return_visit_remaining_scope"\)/);
  assert.match(easer['EaserViews.swift'], /DetailBlock\(title: "Return visit"\)/, 'the Easer sees when to go back and what is left');
  const home = customer['CustomerHome.swift'];
  const tile = home.slice(home.indexOf('private struct ServiceTile'), home.indexOf('private struct SeasonSection'));
  assert.match(tile, /\.frame\(height: 150\)[\s\S]*\.overlay[\s\S]*scaledToFill\(\)[\s\S]*\.clipShape\(/, 'a tile photo fills a fixed card and is clipped there, so it cannot cover the tile beside it');

  // Owner, 2026-10-14: no badge strip ("ID-verified pros / Flat prices") at the bottom
  // of Home; this time of year's picks instead, chosen by the server, with prices.
  assert.doesNotMatch(home, /ID-verified pros|Flat prices, set before you book|struct TrustRow/, 'the badge strip is gone');
  assert.match(home, /if let season = catalog\.season \{\s*SeasonSection\(season: season, catalog: catalog\)/, 'Home shows the season the server chose');
  const seasonView = home.slice(home.indexOf('private struct SeasonSection'));
  assert.match(seasonView, /Text\(season\.title\)/, 'the title comes from the server');
  assert.ok(seasonView.includes('Text("Through \\(through)")'), 'the end date comes from the server');
  assert.match(seasonView, /UIImage\(systemName: name\) != nil/, 'an unknown symbol name never draws a blank');
  assert.match(seasonView, /Array\(all\.prefix\(firstShown\)\)/, 'three picks show first; See all opens the rest');
  assert.match(seasonView, /ItemRow\(item: entry\.item/, 'each pick shows its catalog price and an Add button');
  assert.match(customer['CustomerModels.swift'], /season = try\? c\.decodeIfPresent\(CatalogSeason\.self, forKey: DynamicKey\("season"\)\)/);
  assert.match(read('api/booking/catalog.js'), /\n    season,\n/, 'the catalog sends the season');
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

  // Owner, 2026-10-14, before App Review: the privacy manifest names every kind of
  // data the booking takes, and the App Store rating ask follows any rating.
  const manifest = read('mobile/ios/Customer/Support/PrivacyInfo.xcprivacy');
  for (const type of ['EmailAddress', 'Name', 'PhoneNumber', 'PhysicalAddress', 'PhotosorVideos', 'OtherUserContent', 'PurchaseHistory', 'PaymentInfo', 'UserID', 'DeviceID']) {
    assert.ok(manifest.includes('NSPrivacyCollectedDataType' + type + '<'), `the privacy manifest declares ${type}`);
  }
  assert.doesNotMatch(manifest, /<key>NSPrivacyTracking<\/key>\s*<true\/>/, 'no tracking');
  const rating = views.slice(views.indexOf('private struct RatingCard'), views.indexOf('private struct ActionTile'));
  assert.match(rating, /@Environment\(\\\.requestReview\)/, "Apple's rating sheet, not a custom one");
  assert.doesNotMatch(rating, /if [^\n]*stars\s*>=?\s*[3-5][^\n]*\{[^}]*requestReview\(\)/, 'the App Store ask never depends on the stars given');

  // Browse first (5.1.1(v)): Home, services and prices open without an account;
  // sign-in is asked at Continue after the time is picked, and on Activity and Account.
  const appFile = customer['CustomerApp.swift'];
  assert.match(appFile, /case \.signedOut, \.signedIn:\s*\n(?:\s*\/\/[^\n]*\n)*\s*CustomerTabsView\(\)/, 'a signed-out customer lands on Home, not a sign-in wall');
  assert.match(appFile, /if store\.phase == \.signedIn \{\s*ActivityView\(\)\s*\} else \{\s*CustomerSignInView\(/, 'Activity asks for sign-in when signed out');
  assert.match(appFile, /if store\.phase == \.signedIn \{\s*CustomerAccountView\(\)\s*\} else \{\s*CustomerSignInView\(/, 'Account asks for sign-in when signed out');
  const booking = customer['CustomerBooking.swift'];
  const schedule = booking.slice(booking.indexOf('private struct ScheduleStepView'), booking.indexOf('private struct DetailsStepView'));
  assert.match(schedule, /if store\.phase == \.signedIn \{\s*flow\.path\.append\(\.details\)\s*\} else \{\s*signingIn = true/, 'the details step, which uses the account email, is reached only signed in');
  assert.match(schedule, /onChange\(of: store\.phase\)[\s\S]*?flow\.path\.append\(\.details\)/, 'signing in carries straight on to the details step');
  assert.match(customer['CustomerStore.swift'], /phase = \.signedOut\s*\n\s*offer = await api\.currentOffer\(\)/, 'a guest sees the current offer');
  assert.match(customer['CustomerAPI.swift'], /func catalog\(\)[\s\S]{0,120}publicCall\("GET", "\/api\/booking\/catalog"\)/, 'the catalog needs no account');
  assert.match(customer['CustomerAPI.swift'], /publicCall\("POST", "\/api\/booking\/promo-preview"/, 'the price check needs no account');
}

console.log('PASS customer native app: separate app with its own bundle ID and workflow, shared code compiled by both, every endpoint and field matches the server, prices and permissions from the server, in-app account deletion.');
