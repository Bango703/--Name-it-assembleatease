#!/usr/bin/env node
// Easer app (App Store / Google Play), 2026-09-30. Owner: "get it ready for app
// version without breaking web". This holds both halves shut:
//   - on the website nothing app-specific runs, and push behaves exactly as before
//   - in the app, native push is sent correctly and dead devices are cleaned up

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { sendNativePushToUser, buildFcmMessage, loadFirebaseServiceAccount, buildServiceAccountJwt } from '../api/_native-push.js';

const read = (f) => readFileSync(f, 'utf8');

// ── 1. Website: the app bridge does nothing without Capacitor ────────────────
{
  let fetched = 0;
  const sandbox = { window: {}, document: { readyState: 'complete', addEventListener() {} }, fetch: () => { fetched++; return Promise.resolve({ ok: true }); }, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
  sandbox.window.fetch = sandbox.fetch;
  vm.runInNewContext(read('assets/js/native-app.js'), sandbox);
  assert.equal(fetched, 0, 'on the website the app bridge makes no request');
}
{
  let fetched = 0;
  const sandbox = { window: { Capacitor: { isNativePlatform: () => false } }, document: { readyState: 'complete', addEventListener() {} }, fetch: () => { fetched++; } };
  vm.runInNewContext(read('assets/js/native-app.js'), sandbox);
  assert.equal(fetched, 0, 'Capacitor present but not native (web build) does nothing either');
}

// Web-only flows are gated only by the native check
const app = read('assets/js/app.js');
assert.match(app, /window\.AAE_isNativeApp = function/);
assert.match(app, /if \(window\.AAE_isNativeApp && window\.AAE_isNativeApp\(\)\) return;/, 'install button / service worker skipped only in the app');
assert.match(read('assembler/index.html'), /if\(window\.Capacitor&&typeof window\.Capacitor\.isNativePlatform==='function'&&window\.Capacitor\.isNativePlatform\(\)\) return;/, 'web push prompt skipped only in the app');
for (const page of ['assembler/index.html', 'assembler/my-assignments.html', 'assembler/profile.html', 'assembler/payouts.html']) {
  assert.match(read(page), /assets\/js\/native-app\.js\?v=[^"]+" defer/, `${page} loads the app bridge deferred`);
}

// The app project never ships with the website
const vercelIgnore = read('.vercelignore');
assert.match(vercelIgnore, /^mobile\/$/m);
assert.match(vercelIgnore, /^codemagic\.yaml$/m);

// ── 2. Push: web result unchanged when there is no app to reach ──────────────
const push = read('api/_push.js');
assert.match(push, /if \(native\.skipped\) return web;/, 'no app configured or installed means the web push result, unchanged');
{
  const r = await sendNativePushToUser({}, 'u1', { title: 'x' }, {}, { env: {} });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'native_push_not_configured');
}

// ── 3. Native push behaviour with a configured Firebase project ─────────────
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const account = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey, project_id: 'aae-proj' };
const env = { FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(account)).toString('base64') };
assert.equal(loadFirebaseServiceAccount(env).project_id, 'aae-proj', 'base64 service account accepted');
assert.equal(loadFirebaseServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(account) }).project_id, 'aae-proj', 'raw JSON accepted');
assert.equal(buildServiceAccountJwt(account).split('.').length, 3);

const msg = buildFcmMessage('tok', { title: 'New job', body: 'Desk assembly', url: '/assembler/my-assignments?job=b1', jobId: 'b1' });
assert.equal(msg.message.token, 'tok');
assert.equal(msg.message.data.url, '/assembler/my-assignments?job=b1', 'tapping opens the job');
assert.equal(typeof msg.message.data.jobId, 'string', 'FCM data values are strings');
assert.equal(msg.message.android.notification.channel_id, 'jobs');

function fakeDb(tokens) {
  const deleted = [];
  return {
    deleted,
    from() {
      return {
        select() { return this; },
        eq() { return Promise.resolve({ data: tokens, error: null }); },
        delete() { return { in: (_c, vals) => { deleted.push(...vals); return Promise.resolve({ error: null }); } }; },
      };
    },
  };
}
{
  const db = fakeDb([{ token: 'good', platform: 'ios' }, { token: 'gone', platform: 'android' }, { token: 'badpayload', platform: 'ios' }]);
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    const token = JSON.parse(opts.body).message.token;
    if (token === 'gone') return { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) };
    if (token === 'badpayload') return { ok: false, status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT' } }) };
    return { ok: true, json: async () => ({ name: 'm1' }) };
  };
  const r = await sendNativePushToUser(db, 'u1', { title: 'New job', body: 'b' }, { bookingId: 'b1', notificationType: 'dispatch_offer' }, { env, fetchImpl });
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 2);
  assert.deepEqual(db.deleted, ['gone'], 'only a device FCM says is gone is removed, never one that hit our own payload error');
  assert.equal(r.logRows.length, 3, 'every attempt is logged for the owner');
  assert.ok(r.logRows.every((row) => row.channel === 'push' && row.booking_id === 'b1'));
}
{
  const missingTableDb = { from() { return { select() { return this; }, eq() { return Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.native_push_tokens'" } }); } }; } };
  const r = await sendNativePushToUser(missingTableDb, 'u1', { title: 'x' }, {}, { env, fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(r.skipped, true, 'before migration 103 runs, native push is simply skipped');
  assert.equal(r.reason, 'native_push_table_missing');
}

// ── 4. Registration endpoint and app project essentials ─────────────────────
const reg = read('api/assembler/native-push-register.js');
assert.match(reg, /authenticateBearerUser\(req\)/, 'only a signed-in Easer can register a device');
assert.match(reg, /profile\.role !== 'assembler'/);
assert.match(reg, /onConflict: 'token'/, 'a phone used by a new Easer moves to them');
assert.match(reg, /\.eq\('token', token\)\.eq\('user_id', authed\.user\.id\)/, 'sign-out only removes your own device');

const cap = JSON.parse(read('mobile/capacitor.config.json'));
assert.equal(cap.appId, 'com.assembleatease.easer');
assert.equal(cap.server.url, 'https://www.assembleatease.com/assembler/my-assignments', 'the app opens the live Easer pages, so web fixes reach the app without a store update');
assert.equal(cap.server.errorPath, 'offline.html');
assert.ok(existsSync('mobile/www/offline.html'));
const plist = read('mobile/ios/App/App/Info.plist');
assert.match(plist, /NSCameraUsageDescription/, 'Apple requires a reason before the camera opens for job photos');
assert.match(plist, /<string>remote-notification<\/string>/);
assert.match(read('mobile/ios/App/App/App.entitlements'), /aps-environment/);
assert.match(read('mobile/ios/App/App.xcodeproj/project.pbxproj'), /GoogleService-Info\.plist in Resources/, 'Firebase config is bundled into the iOS app');
assert.match(read('mobile/ios/App/App/AppDelegate.swift'), /capacitorDidRegisterForRemoteNotifications/);
assert.match(read('mobile/android/app/src/main/AndroidManifest.xml'), /default_notification_icon/);
assert.match(read('codemagic.yaml'), /submit_to_testflight: true/);

console.log('PASS native app: website untouched (bridge inert, web push unchanged, app kept out of deploys); native push sends, logs, and cleans up only dead devices.');
