#!/usr/bin/env node
// iPhone Easers take job offers in the Easer app; everyone else keeps the
// website (owner, 2026-11-08). Off until EASER_IPHONE_APP_REQUIRED_FROM is set.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { easerAppPolicy, isIPhoneBrowser, offersBelongInApp, EASER_IOS_APP_URL, easerAppStatus } from '../api/_easer-app-policy.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const IPOD = 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const NATIVE_APP = 'Easer/12 CFNetwork/1568.200.51 Darwin/24.1.0';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Who counts as an iPhone browser.
{
  assert.equal(isIPhoneBrowser(SAFARI), true);
  assert.equal(isIPhoneBrowser(CHROME_IOS), true);
  assert.equal(isIPhoneBrowser(IPOD), false, 'iPod touch reads "(iPod touch;" and stays on the web');
  for (const [ua, who] of [[IPAD, 'iPad (desktop-class Safari)'], [ANDROID, 'Android'], [NATIVE_APP, 'the Easer app itself'], [DESKTOP, 'desktop'], ['', 'no header'], [undefined, 'missing']]) {
    assert.equal(isIPhoneBrowser(ua), false, `${who} keeps the website`);
  }
}
console.log('PASS browser: iPhone Safari and Chrome only; the Easer app, iPad, Android and desktop are never caught');

// Off until the owner sets a date; on from that Austin date.
{
  const now = new Date('2026-11-20T18:00:00Z');
  assert.deepEqual(easerAppPolicy({ env: {}, now }), { iosAppUrl: EASER_IOS_APP_URL, iphoneRequiredFrom: null, iphoneRequired: false });
  assert.equal(easerAppPolicy({ env: { EASER_IPHONE_APP_REQUIRED_FROM: 'soon' }, now }).iphoneRequired, false, 'a malformed date is off');
  assert.equal(easerAppPolicy({ env: { EASER_IPHONE_APP_REQUIRED_FROM: '2026-13-40' }, now }).iphoneRequiredFrom, null, 'an impossible date is off');
  const ahead = easerAppPolicy({ env: { EASER_IPHONE_APP_REQUIRED_FROM: '2026-11-23' }, now });
  assert.equal(ahead.iphoneRequired, false); assert.equal(ahead.iphoneRequiredFrom, '2026-11-23');
  assert.equal(easerAppPolicy({ env: { EASER_IPHONE_APP_REQUIRED_FROM: '2026-11-20' }, now }).iphoneRequired, true, 'on from the day itself');
  // 2026-11-23 01:00 UTC is still Nov 22 in Austin.
  assert.equal(easerAppPolicy({ env: { EASER_IPHONE_APP_REQUIRED_FROM: '2026-11-23' }, now: new Date('2026-11-23T01:00:00Z') }).iphoneRequired, false, 'Austin calendar, not UTC');
  const off = easerAppPolicy({ env: {}, now });
  const on = easerAppPolicy({ env: { EASER_IPHONE_APP_REQUIRED_FROM: '2026-11-01' }, now });
  assert.equal(offersBelongInApp({ headers: { 'user-agent': SAFARI } }, off), false, 'unset: nothing changes for anyone');
  assert.equal(offersBelongInApp({ headers: { 'user-agent': SAFARI } }, on), true);
  assert.equal(offersBelongInApp({ headers: { 'user-agent': NATIVE_APP } }, on), false, 'the app is never sent to itself');
  assert.equal(offersBelongInApp({ headers: { 'user-agent': ANDROID } }, on), false);
  assert.equal(offersBelongInApp({ headers: {} }, on), false);
}
console.log('PASS policy: off until a valid date is set, on from that Austin day, only for iPhone browsers');

// The server decides; the routes and the page follow it.
{
  const list = read('api/booking/my-assignments.js');
  assert.match(list, /const offersInApp = offersBelongInApp\(req, app\);/);
  assert.match(list, /const listed = offersInApp \? allBookings\.filter\(booking => Boolean\(booking\.assembler_accepted_at\)\) : allBookings;/, 'only unaccepted work leaves the web list; accepted jobs stay');
  assert.match(list, /bookings: listed,/);
  assert.match(list, /app: \{ \.\.\.app, iphoneBrowser: isIPhoneBrowser\(req\.headers\?\.\['user-agent'\]\), offersInApp \},/);

  const accept = read('api/booking/accept-dispatch.js');
  const method = accept.indexOf("if (req.method !== 'POST') return res.status(405)");
  const gate = accept.indexOf('if (offersBelongInApp(req, appPolicy))');
  const auth = accept.indexOf('// Verify JWT');
  assert.ok(method > 0 && gate > method && auth > gate, 'refused before any work, after the method check');
  assert.match(accept, /error: 'Accept this job in the Easer app\.', code: 'EASER_APP_REQUIRED', appUrl: appPolicy\.iosAppUrl/);

  const page = read('assembler/my-assignments.html');
  assert.match(page, /<div id="easer-app-banner" role="status"/);
  assert.match(page, /if \(!app \|\| app\.iphoneBrowser !== true \|\| !app\.iosAppUrl\) \{ el\.style\.display = 'none'; return; \}/, 'the page shows the server\'s answer');
  assert.match(page, /allAssignments = data\.bookings \|\| \[\];\n\s*renderEaserAppBanner\(data\.app\);/);
  const banner = page.slice(page.indexOf('function renderEaserAppBanner'), page.indexOf('function isOfferAssignment'));
  assert.doesNotMatch(banner, /navigator\.userAgent/, 'no browser-side guess at the device');
  assert.match(page, /const msg = d\.error \|\| 'Could not accept/, 'a refused accept shows the server\'s words');
}
console.log('PASS wiring: server filters and refuses; the page renders its verdict and never guesses the device');

// The owner sees who has the app, and never a guess.
{
  const sb = (result) => ({ from: () => ({ select: () => ({ eq: async () => result }) }) });
  assert.deepEqual(await easerAppStatus(sb({ data: [{ platform: 'ios' }, { platform: 'ios' }], error: null }), 'u1'), { known: true, installed: true, platforms: ['ios'], label: 'Signed in on iPhone' });
  assert.equal((await easerAppStatus(sb({ data: [], error: null }), 'u1')).label, 'No app sign-in recorded');
  const unknown = await easerAppStatus(sb({ data: null, error: { message: 'down' } }), 'u1');
  assert.equal(unknown.known, false); assert.equal(unknown.installed, null, 'unreadable is unknown, never "no app"');
  assert.match(read('api/owner/easer-readiness.js'), /easerApp: await easerAppStatus\(sb, profile\.id\),/);
  assert.match(read('owner/index.html'), /\['Easer App', esc\(\(r\.easerApp && r\.easerApp\.label\) \|\| 'Unknown'\)\],/);
}
console.log('PASS owner: the Easer panel shows who is signed in on the app; an unreadable record says unknown');
console.log('\nEaser app policy tests passed.');
