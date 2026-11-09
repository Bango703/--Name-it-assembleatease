#!/usr/bin/env node
// iPhone Easers take job offers in the Easer app; everyone else keeps the
// website (owner, 2026-11-08). Off until EASER_IPHONE_APP_REQUIRED_FROM is set.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { easerAppPolicy, isIPhoneBrowser, isEaserNativeApp, offersBelongInApp, EASER_IOS_APP_URL, easerAppStatus } from '../api/_easer-app-policy.js';
import { TARGET_RULES, getEaserRequiredActions, markEaserAppSeen } from '../api/_announcements.js';

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

// A small in-memory database: each table is a list of rows; filters narrow it.
function fakeDb(tables, { fail = [] } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      let rows = (tables[table] || []).slice();
      const q = {
        select() { return q; },
        eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
        in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        not(col) { rows = rows.filter((r) => r[col] != null); return q; },
        lte() { return q; },
        or() { return q; },
        maybeSingle: async () => ({ data: rows[0] || null, error: null }),
        upsert: async (values, opts) => { writes.push({ table, values, opts }); return { error: null }; },
        then(resolve, reject) {
          const result = fail.includes(table) ? { data: null, error: { message: table + ' down' } } : { data: rows, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
const ANN = { id: 'ann-app', key: 'easer_app_download', target_rule: 'easer_app_missing', status: 'active', channels: ['email', 'push'], title: 'Get the Easer app', body: 'b', action_label: 'Get the Easer app', action_url: EASER_IOS_APP_URL, type: 'required_action' };
const easer = (id, ua, extra = {}) => ({ id, role: 'assembler', status: 'active', application_status: 'approved', email: id + '@example.test', contractor_agreement_user_agent: ua, ...extra });

// The app is recognised from its own requests.
{
  assert.equal(isEaserNativeApp(NATIVE_APP), true);
  assert.equal(isEaserNativeApp('App/1 CFNetwork/3826.400.120 Darwin/24.3.0'), true);
  for (const ua of [SAFARI, CHROME_IOS, IPAD, ANDROID, DESKTOP, '', undefined]) assert.equal(isEaserNativeApp(ua), false, String(ua));
}
console.log('PASS app: the Easer app is recognised from iOS networking; no browser is mistaken for it');

// Who is asked to download it: approved, signed on an iPhone, no app use.
{
  const rule = TARGET_RULES.easer_app_missing;
  const db = fakeDb({
    profiles: [easer('a', SAFARI), easer('b', SAFARI), easer('c', SAFARI), easer('d', DESKTOP), easer('e', SAFARI, { status: 'paused' }), easer('f', null)],
    native_push_tokens: [{ user_id: 'b', platform: 'ios' }],
    easer_announcement_deliveries: [{ announcement_id: 'ann-app', easer_id: 'c', completed_at: '2026-11-08T00:00:00Z' }],
  });
  const { data, error } = await rule.query(db, ANN);
  assert.equal(error, null);
  assert.deepEqual(data.map((p) => p.id), ['a'], 'b has a push sign-in, c opened the app, d signed on a computer, e is not active, f has no device on file');
  assert.equal(rule.incomplete(data[0]), true);
  assert.equal(rule.incomplete({ ...easer('x', SAFARI), _easer_app: { iphone: true, hasApp: true } }), false);
  assert.equal(rule.incomplete(easer('y', ANDROID)), false, 'never Android');
  assert.equal(rule.incomplete({ ...easer('z', SAFARI), status: 'pending' }), false, 'never before approval');
  const broken = await rule.query(fakeDb({ profiles: [easer('a', SAFARI)] }, { fail: ['native_push_tokens'] }), ANN);
  assert.equal(broken.error.message, 'native_push_tokens down', 'an unreadable app record fails the run, it does not email everyone');

  const confirmDb = (tables, opts) => fakeDb({ easer_announcements: [ANN], ...tables }, opts);
  assert.deepEqual(await rule.confirmStillIncomplete(confirmDb({ native_push_tokens: [] }), easer('a', SAFARI)), { stillIncomplete: true, verified: true });
  assert.deepEqual(await rule.confirmStillIncomplete(confirmDb({ native_push_tokens: [{ user_id: 'a' }] }), easer('a', SAFARI)), { stillIncomplete: false, verified: true }, 're-checked before each send');
  assert.deepEqual(await rule.confirmStillIncomplete(confirmDb({}, { fail: ['native_push_tokens'] }), easer('a', SAFARI)), { stillIncomplete: true, verified: false }, 'unknown is never sent');
}
console.log('PASS rule: approved iPhone signers without app use are asked; push sign-in or opening the app stops it; every send re-checked');

// No second banner on the web page; the app opening marks the Easer done.
{
  const db = fakeDb({ easer_announcements: [ANN], easer_announcement_deliveries: [] });
  assert.deepEqual(await getEaserRequiredActions(db, easer('a', SAFARI)), [], 'email and push only: the web page shows its own banner');
  assert.equal((await markEaserAppSeen(db, 'a', '2026-11-08T12:00:00Z')).ok, true);
  assert.deepEqual(db.writes[0], { table: 'easer_announcement_deliveries', values: [{ announcement_id: 'ann-app', easer_id: 'a', completed_at: '2026-11-08T12:00:00Z', updated_at: '2026-11-08T12:00:00Z' }], opts: { onConflict: 'announcement_id,easer_id' } });
  const none = fakeDb({ easer_announcements: [] });
  assert.equal((await markEaserAppSeen(none, 'a')).ok, true);
  assert.equal(none.writes.length, 0, 'nothing to mark before migration 125');
  for (const m of ['057_easer_announcements.sql', '093_easer_sms_consent_announcement.sql', '102_easer_cancellation_policy_announcement.sql']) {
    assert.match(read('api/migrations/' + m), /ARRAY\['email', 'in_app', 'push'\]/, `${m}: existing banners keep in_app, so the channel check changes nothing for them`);
  }
  const route = read('api/assembler/required-actions.js');
  assert.match(route, /contractor_agreement_user_agent'\)/, 'the route selects every column the rule reads');
  assert.match(route, /if \(isEaserNativeApp\(req\.headers\?\.\['user-agent'\]\)\) \{\s*await markEaserAppSeen\(sb, profile\.id\)\.catch\(\(\) => \{\}\);/);
  const mig = read('api/migrations/125_easer_app_announcement.sql');
  assert.match(mig, /'easer_app_download',[\s\S]*'easer_app_missing',\s*false,\s*ARRAY\['email', 'push'\]::TEXT\[\],\s*ARRAY\[0, 4\]::INTEGER\[\],\s*'active'/);
  assert.match(mig, /VALUES \(125, 'easer_app_announcement'\)/);
}
console.log('PASS channels: no duplicate web banner, existing banners unchanged, the app marks its Easer done, migration 125 seeds email+push');

// The owner sees who uses the app and who signed on an iPhone, never a guess.
{
  const tables = { easer_announcements: [ANN], native_push_tokens: [{ user_id: 'a' }], easer_announcement_deliveries: [{ announcement_id: 'ann-app', easer_id: 'c', completed_at: 'x' }] };
  assert.equal((await easerAppStatus(fakeDb(tables), easer('a', SAFARI))).label, 'Uses the Easer app; signed the agreement on an iPhone');
  assert.equal((await easerAppStatus(fakeDb(tables), easer('c', SAFARI))).label, 'Uses the Easer app; signed the agreement on an iPhone', 'opened the app with notifications off');
  assert.equal((await easerAppStatus(fakeDb(tables), easer('d', DESKTOP))).label, 'No Easer app use recorded; signed the agreement on another device');
  assert.equal((await easerAppStatus(fakeDb(tables), easer('f', null))).label, 'No Easer app use recorded; agreement device not recorded');
  const unknown = await easerAppStatus(fakeDb(tables, { fail: ['native_push_tokens'] }), easer('a', SAFARI));
  assert.equal(unknown.known, false);
  assert.equal(unknown.installed, null, 'unreadable is unknown, never "no app"');
  assert.match(read('api/owner/easer-readiness.js'), /easerApp: await easerAppStatus\(sb, profile\),/);
  assert.match(read('owner/index.html'), /\['Easer App', esc\(\(r\.easerApp && r\.easerApp\.label\) \|\| 'Unknown'\)\],/);
}
console.log('PASS owner: the Easer panel says who uses the app and who signed on an iPhone; unreadable says unknown');
console.log('\nEaser app policy tests passed.');
