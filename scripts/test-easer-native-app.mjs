#!/usr/bin/env node
// Easer native iPhone app, 2026-10-08. Owner: "this must only be the app, it should
// not interfere with anything on the web ... it needs to be properly rebuilt, feels
// like an app". The app is native SwiftUI and reads the existing server. This guard
// holds the contract between the two, because nothing compiles the Swift here:
//   - every endpoint and server field the app reads exists, under that exact name
//   - the app never decides a business rule the server owns (availability, money)
//   - it is Easer-only and never loads the website as its interface

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { MAX_UPLOAD_BYTES, IMAGE_MAX_EDGE_PX } from '../api/_upload-limits.js';
import { EASER_STAGE } from '../api/_source-of-truth.js';

const read = (f) => readFileSync(f, 'utf8');
const APP = 'mobile/ios/App/App';
const swiftFiles = readdirSync(APP).filter(f => f.endsWith('.swift'));
const swift = Object.fromEntries(swiftFiles.map(f => [f, read(`${APP}/${f}`)]));
const all = Object.values(swift).join('\n');

// ── 1. Native, Easer-only, not the website ───────────────────────────────────
assert.match(swift['SceneDelegate.swift'], /UIHostingController\(rootView: EaserRootView\(\)\)/, 'the app opens native screens');
assert.doesNotMatch(all, /CAPBridgeViewController|WKWebView/, 'no web view is the interface');
// Documents and Stripe pages open in Apple's in-app browser sheet, never as the
// app's own screens and never by sending the Easer out to the Safari app.
for (const [file, text] of Object.entries(swift)) {
  if (file !== 'EaserSupport.swift') assert.doesNotMatch(text, /SFSafariViewController/, `${file}: web pages go through InAppBrowser only`);
}
assert.match(swift['EaserSupport.swift'], /enum InAppBrowser[\s\S]*SFSafariViewController\(url: url\)/, 'one in-app browser');
assert.match(swift['EaserSupport.swift'], /scheme == "https" \|\| scheme == "http" else \{\s*return \.systemAction/, 'calls, email and Settings keep their system behaviour');
assert.match(swift['EaserViews.swift'], /\.environment\(\\.openURL, InAppBrowser\.action \{[\s\S]{0,160}store\.refresh\(\)/, 'every link in the app opens in the sheet, and closing it refreshes setup status');
assert.match(swift['EaserAccountViews.swift'], /onChange\(of: store\.browserCloses\)[\s\S]{0,400}loadPayouts\(afterStripe: true\)/, 'payout status reloads when the Easer closes Stripe');
assert.doesNotMatch(all, /"\/(book|track|app)(\?|")/, 'no customer booking or customer/Easer chooser in the Easer app');
const plist = read(`${APP}/Info.plist`);
assert.doesNotMatch(plist, /UIMainStoryboardFile|UISceneStoryboardFile/, 'no storyboard creates a web bridge behind the native screens');
for (const key of ['NSCameraUsageDescription', 'NSLocationWhenInUseUsageDescription', 'NSPhotoLibraryUsageDescription']) {
  assert.match(plist, new RegExp(`<key>${key}</key>`), `${key} explains the prompt when it appears`);
}

// ── 2. Every endpoint the app calls exists ───────────────────────────────────
const paths = [...new Set([...all.matchAll(/"(\/api\/[a-z0-9\-/]+)/g)].map(m => m[1]))];
assert.ok(paths.length >= 10, 'the app talks to the existing server');
for (const path of paths) assert.ok(existsSync(`${path.slice(1)}.js`), `${path} exists on the server`);

// ── 3. Field names match the server responses exactly ────────────────────────
const assignments = read('api/booking/my-assignments.js');
for (const field of ['_pay_estimate_lo', '_offer_token', '_offer_expires_at', '_offer_location', '_can_decline', '_booking_items', '_custom_quote', '_crew_role', 'newOffersAllowed', 'assembler_accepted_at', 'customer_phone']) {
  assert.ok(all.includes(`"${field}"`), `app reads ${field}`);
  assert.ok(assignments.includes(field), `${field} is sent by my-assignments`);
}
const earnings = read('api/assembler/_earnings.js');
for (const field of ['awaiting_payout_cents', 'paid_cents', 'on_hold_cents', 'total_earned_cents', 'completed_jobs', 'status_label', 'status_message', 'amount_cents', 'earned_at', 'booking_id']) {
  assert.ok(all.includes(`"${field}"`), `app reads ${field}`);
  assert.ok(earnings.includes(field), `${field} is sent by earnings`);
}
assert.doesNotMatch(all, /pending_cents/, 'no invented earnings field (an earlier draft showed $0.00 from one)');
const readiness = read('api/assembler/readiness.js');
for (const field of ['isReady', 'missingItems', 'suspended']) assert.ok(readiness.includes(field) && all.includes(`"${field}"`), `readiness ${field}`);
const notices = read('api/assembler/notifications.js');
const noticeShape = notices.slice(notices.indexOf('function formatNotification'), notices.indexOf('export default'));
for (const field of ['title', 'detail', 'createdAt', 'read', 'bookingId']) {
  assert.match(noticeShape, new RegExp(`\\b${field}\\b[,:]`), `notification ${field} is sent`);
  assert.ok(all.includes(`"${field}"`), `app reads notification ${field}`);
}

// ── 4. The server decides; the app renders ───────────────────────────────────
const store = swift['EaserStore.swift'];
for (const stage of Object.values(EASER_STAGE)) assert.ok(store.includes(`"stage": "${stage}"`), `status step ${stage} uses the server's stage name`);
assert.match(swift['EaserAPI.swift'], /rpc\/update_own_easer_profile_safe/, 'availability uses the same protected function as the website');
assert.doesNotMatch(all, /"PATCH"|rest\/v1\/profiles[^"]*"[^)]*PATCH/, 'the app never writes the profile table directly');
assert.ok(store.indexOf('/api/booking/upload-evidence') < store.indexOf('/api/booking/assembler-complete'), 'photo first, then completion');
assert.match(store, /"evidenceType": "completion_photo"/);
assert.match(store, /evidenceUploaded/, 'a retried completion does not upload the photo twice');
assert.match(swift['EaserModels.swift'], /\["requested", "reviewing", "completed"\]/, 'same closure hold as the web dashboard');
assert.match(read('assembler/index.html'), /\['requested', 'reviewing', 'completed'\]\.includes\(currentClosureStatus\)/);
assert.doesNotMatch(all, /\* ?0\.(3|7|25|75)\b|platformFee|platform_fee|getPlatformFeePct/, 'the app never computes pay; it shows the server estimate');
assert.doesNotMatch(all, /(grossCents|netCents|feeCents)\s*[-+*/]\s*[A-Za-z(]/, 'instant payout amounts are shown as the server priced them, never recalculated');

// ── 5. Photo limits are the server's ─────────────────────────────────────────
assert.match(swift['EaserSupport.swift'], new RegExp(`maxEdgePixels: CGFloat = ${IMAGE_MAX_EDGE_PX}\\b`));
assert.match(swift['EaserSupport.swift'], new RegExp(`maxUploadBytes = ${MAX_UPLOAD_BYTES}\\b`));

// ── 6. Session, sign-in and push ─────────────────────────────────────────────
assert.match(swift['EaserSupport.swift'], /kSecClassGenericPassword/, 'the session is kept in the Keychain');
assert.doesNotMatch(all, /UserDefaults[^\n]*(session|token|access)/i, 'no token in plain app storage');
assert.match(swift['EaserAPI.swift'], /grant_type[\s\S]*refresh_token/, 'an expired session refreshes instead of stranding the Easer');
const webConfig = read('config.js');
const supabaseUrl = webConfig.match(/https:\/\/[a-z0-9]+\.supabase\.co/)?.[0];
const publicKey = webConfig.match(/sb_publishable_[A-Za-z0-9_]+/)?.[0];
assert.ok(supabaseUrl && publicKey, 'website sign-in config found');
assert.ok(all.includes(supabaseUrl) && all.includes(publicKey), 'the app signs in through the same project as the website');
assert.match(store, /guard me\.role == "assembler"/, 'Easer accounts only');
assert.match(store, /"platform": "ios"/);
assert.match(store, /"DELETE", "\/api\/assembler\/native-push-register"/, 'signing out stops this phone receiving the Easer\'s jobs');
assert.match(swift['AppDelegate.swift'], /Messaging\.messaging\(\)\.apnsToken = deviceToken/);
assert.match(swift['AppDelegate.swift'], /path\(forResource: "GoogleService-Info", ofType: "plist"\) != nil/, 'runs without Firebase config instead of crashing');
assert.match(store, /\/api\/assembler\/request-account-closure/, 'an Easer can start account deletion inside the app');

// ── 7. Project wiring ────────────────────────────────────────────────────────
const pbx = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
for (const file of swiftFiles) assert.match(pbx, new RegExp(`/\\* ${file.replace('.', '\\.')} in Sources \\*/,`), `${file} is compiled`);
assert.match(pbx, /PrivacyInfo\.xcprivacy in Resources \*\/,/, 'privacy manifest ships in the app');
assert.doesNotMatch(pbx, /IPHONEOS_DEPLOYMENT_TARGET = 1[0-6]\./, 'iOS 17 minimum, matching the screens used');
const privacy = read(`${APP}/PrivacyInfo.xcprivacy`);
assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
assert.match(privacy, /NSPrivacyAccessedAPICategoryUserDefaults[\s\S]*CA92\.1/);
// Same eight data types as the App Privacy answers published in App Store Connect (2026-10-09).
for (const type of ['Name', 'EmailAddress', 'PhoneNumber', 'PreciseLocation', 'PhotosorVideos', 'OtherUserContent', 'UserID', 'DeviceID']) {
  assert.ok(privacy.includes(`<string>NSPrivacyCollectedDataType${type}</string>`), `privacy manifest declares ${type}`);
}
assert.doesNotMatch(privacy, /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\/>/, 'nothing is used for tracking');
assert.doesNotMatch(all, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');

// ── 8a. Full job tree: release, photo requests, damage, customer photos ─────
for (const field of ['_can_self_drop', 'evidence_requested_at', '_evidence_uploaded']) {
  assert.ok(all.includes(`"${field}"`), `app reads ${field}`);
  assert.ok(assignments.includes(field), `${field} is sent by my-assignments`);
}
const dropJob = read('api/booking/drop-job.js');
const serverReasons = JSON.parse(dropJob.match(/DROP_REASONS = new Set\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'));
const appReasons = JSON.parse(store.match(/releaseReasons = (\[[^\]]+\])/)[1]);
assert.deepEqual(appReasons, serverReasons, 'release reasons are the server\'s list');
assert.match(store, /"preview": true/, 'the reliability cost is shown before releasing');
assert.match(swift['EaserModels.swift'], /status == "confirmed" && selfDropAllowed/, 'release offered only before travel, as on the web');
const webAssign = read('assembler/my-assignments.html');
for (const sentence of [
  'You accepted this job less than 15 minutes ago, so cancelling now has no reliability strike.',
  'The job is more than 24 hours away, so cancelling now has no reliability strike.',
  ' This cancellation will pause new jobs until AssembleAtEase reviews your account.',
]) {
  assert.ok(webAssign.includes(sentence) && swift['EaserModels.swift'].includes(sentence), `release warning matches the web: ${sentence.trim()}`);
}
const evidenceTypes = read('api/booking/upload-evidence.js');
for (const type of ['completion_photo', 'damage_claim']) assert.ok(evidenceTypes.includes(`'${type}'`) && store.includes(`"${type}"`), `evidence type ${type}`);
assert.match(evidenceTypes, /damage_claim' && cleanNotes\.length < 10/);
assert.match(all, /count >= 10/, 'damage report asks for the same minimum description as the server');

// ── 8b. Profile photo and logo ──────────────────────────────────────────────
assert.match(swift['EaserAPI.swift'], /select", value: "[^"]*profile_photo/, 'profile photo is read');
assert.match(swift['EaserAPI.swift'], /"profile_photo": dataURL/, 'profile photo saved through the protected function');
const profilePage = read('assembler/profile.html');
assert.match(profilePage, /const MAX = 384;/);
assert.match(profilePage, /photoBase64\.length > 350000/);
assert.match(swift['EaserSupport.swift'], /maxEdgePixels: CGFloat = 384\b[\s\S]*maxDataURLLength = 350000\b/, 'same profile photo size as the website');
const logoAsset = readFileSync(`${APP}/Assets.xcassets/AAELogo.imageset/AAELogo.jpg`);
assert.ok(logoAsset.equals(readFileSync('images/logo.jpg')), 'the in-app logo is the real AAE logo file');
assert.match(swift['EaserSupport.swift'], /Image\("AAELogo"\)/);
assert.doesNotMatch(all, /wrench\.and\.screwdriver/, 'no stand-in symbol where the logo belongs');

// ── 8c. Account, profile and payouts ────────────────────────────────────────
const webFields = read('assets/js/app.js').match(/EASER_BOOTSTRAP_PROFILE_FIELDS = \[([\s\S]*?)\]/)[1].match(/'([a-z_]+)'/g).map(f => f.replace(/'/g, ''));
const appFields = swift['EaserAPI.swift'].match(/name: "select", value: "([^"]+)"/)[1].split(',');
for (const field of appFields) assert.ok(webFields.includes(field), `profile column ${field} is one the website already reads (an unreadable column would break sign-in)`);
assert.match(swift['EaserAPI.swift'], /email: \(user\["email"\] as\? String\)/, 'email comes from the sign-in response');
assert.match(swift['EaserAPI.swift'], /auth\/v1\/recover[\s\S]*\/auth\/set-password/, 'password reset returns to the same page as the website');
const payoutsPage = read('assembler/payouts.html');
const webMethods = [...payoutsPage.matchAll(/<option value="([a-z]+)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]);
const appMethods = [...store.matchAll(/PayoutMethod\(value: "([a-z]+)", label: "([^"]+)"\)/g)].map(m => [m[1], m[2]]);
assert.deepEqual(appMethods, webMethods, 'payout methods are the website\'s list');
assert.match(store, /"acknowledgedFeeCents": Int\(quote\.feeCents\.rounded\(\)\)/, 'instant payout sends the fee the Easer was shown');
assert.match(swift['EaserModels.swift'], /instantAvailable"\) \?\? false\) && \(c\.bool\("eligible"\)/, 'instant payout shown only when the server says it can be sent');
const smsApi = read('api/assembler/sms-preference.js');
for (const field of ['enabled', 'hasPhone', 'optedOut']) assert.ok(smsApi.includes(field) && swift['EaserModels.swift'].includes(`"${field}"`), `text alert ${field}`);
assert.match(swift['EaserViews.swift'], /guard online else \{ return "Paused" \}/, 'job alerts never claim to be on while the Easer is offline');
assert.doesNotMatch(all, /opens in Safari/, 'no mechanics in customer- or Easer-facing copy');
assert.match(swift['EaserModels.swift'], /case "starter": return "Starter Pro"/);
assert.match(profilePage, /starter: 'Starter Pro'/, 'level labels match the website');

// ── 8d. Audit fixes (2026-10-09) ────────────────────────────────────────────
assert.match(store, /loadedOnce = true[\s\S]{0,700}?await pushTokenChanged\(PushRelay\.shared\.fcmToken\)/, 'job alerts register after the profile loads, not only when the token changes');
assert.match(swift['AppDelegate.swift'], /PushRelay\.shared\.arrivals \+= 1/, 'an alert arriving while the app is open reloads the jobs');
assert.match(swift['EaserViews.swift'], /reloadedFor == id/, 'tapping an alert for a job not yet loaded reloads once, then says it is gone');
assert.match(swift['EaserViews.swift'], /if store\.appActive \{ await store\.refreshJobs\(\) \}/, 'the open app keeps offers current');
assert.match(store, /sorted \{ \$0\.startSortKey < \$1\.startSortKey \}/, 'Up next is the soonest job, not the most recently assigned');
assert.match(assignments, /order\('assigned_at', \{ ascending: false \}\)/, 'the server order is by assignment, which is why the app sorts');
for (const code of ['current_agreement_required', 'new_offers_paused']) {
  assert.ok(assignments.includes(`'${code}'`) && swift['EaserModels.swift'].includes(`"${code}"`), `paused-offer reason ${code} comes from the server`);
}
assert.doesNotMatch(swift['EaserViews.swift'], /Open Account to see what is needed/, 'no pointer to a screen that does not have the answer');
assert.match(store, /func payText\(for job: EaserJob\)[\s\S]*earning\(for: job\)/, 'finished jobs show the recorded earning, not "Pay to be confirmed"');
assert.match(assignments, /status === BOOKING_STATUS\.COMPLETED && !b\._return_visit_open\) return;/, 'the server sends no estimate for completed jobs');

// ── 8e. Speed: each part of the screen shows when its data arrives ────────────
assert.match(store, /withTaskGroup\(of: LoadedPart\.self\)/, 'screens load progressively');
assert.match(store, /for await part in group/, 'results are applied as they arrive, not after the slowest one');

// ── 8f. Onboarding inside the app (2026-10-09) ──────────────────────────────
// "Finish setup" used to open the website in Safari, which is not signed in, so a
// new Easer could not finish. The app now signs the agreement itself.
const verify = read('api/assembler/verification-link.js');
for (const field of ['contractorAgreementSigned', 'codeOfConductAccepted', 'fullName', 'verificationUrl', 'alreadyVerified', 'requiresAgreement', 'identityVerified']) {
  assert.ok(verify.includes(field) && all.includes(`"${field}"`), `onboarding field ${field} matches the server`);
}
assert.match(verify, /auth\.startsWith\('Bearer '\)/, 'the endpoint accepts the app session');
const verifyPage = read('assembler/verify-identity.html');
for (const sentence of [
  'I have read the Independent Contractor Agreement in full and agree to be legally bound by its terms.',
  'and I understand identity verification is required before I can receive jobs.',
]) {
  assert.ok(verifyPage.replace(/<[^>]+>/g, '').includes(sentence) && swift['EaserViews.swift'].includes(sentence), `consent wording matches the website: ${sentence}`);
}
assert.doesNotMatch(all, /Site\.page\("\/assembler\/verify-identity"\)/, 'identity check starts from the app session, not a signed-out web page');
assert.match(swift['EaserViews.swift'], /if !store\.needsSetup \{ AvailabilityCard\(\) \}/, 'no online switch the server would refuse while setup is unfinished');
assert.match(swift['EaserViews.swift'], /store\.profile\?\.closureHeld == true \|\| store\.needsSetup\)/, 'Account availability is disabled until setup is done');
assert.match(swift['EaserViews.swift'], /\.disabled\(blockedReason != nil \|\| working\)[\s\S]{0,200}if let blockedReason \{ Text\(blockedReason\) \}/, 'the Sign button never sits disabled without saying why (Article 14)');
assert.doesNotMatch(swift['EaserViews.swift'], /Button\("Finish setup"\)/, 'no setup button that sends a signed-in Easer to a signed-out browser');
assert.match(store, /status == 403[\s\S]{0,80}jobsLocked = true/, 'an account not approved yet is a status, not "Jobs could not be loaded"');
assert.match(store, /if jobsLocked \|\| readiness\?\.isReady == false/, 'approved Easers never call the onboarding endpoint');

// ── 8. The website is untouched by the app build ─────────────────────────────
assert.equal(JSON.parse(read('mobile/capacitor.config.json')).server.url, 'https://www.assembleatease.com/app', 'Android keeps its existing shell; iOS no longer reads this');

console.log('PASS easer native app: native Easer-only screens, every endpoint and field matches the server, server decides availability and pay, photo limits shared, Keychain session with refresh, push registered and removed, closure in-app.');
