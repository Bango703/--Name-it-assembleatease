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
assert.doesNotMatch(all, /CAPBridgeViewController|WKWebView|SFSafariViewController/, 'no web view is the interface');
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
assert.doesNotMatch(all, /\* ?0\.(3|7|25|75)\b|platformFee|feePct/, 'the app never computes pay; it shows the server estimate');

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

// ── 8. The website is untouched by the app build ─────────────────────────────
assert.equal(JSON.parse(read('mobile/capacitor.config.json')).server.url, 'https://www.assembleatease.com/app', 'Android keeps its existing shell; iOS no longer reads this');

console.log('PASS easer native app: native Easer-only screens, every endpoint and field matches the server, server decides availability and pay, photo limits shared, Keychain session with refresh, push registered and removed, closure in-app.');
