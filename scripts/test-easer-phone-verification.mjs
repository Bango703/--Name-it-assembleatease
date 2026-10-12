#!/usr/bin/env node
// A changed Easer phone number is confirmed with a texted code (2026-10-12).
// Owner asked whether texts still go out after an Easer changes their number.
// They did, at once, on consent given for the old number, so a typo texted job
// offers to a stranger. This guard holds the fix:
//   - the code rules (expiry, tries, resend limits, consent follow-through)
//   - the database refuses a phone change from the Easer's own session
//   - the website and the app change the number only through the code endpoint

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CODE_TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS, MAX_SENDS_PER_WINDOW, SEND_WINDOW_MS,
  newCode, hashCode, codeMatches, sendDecision, verifyDecision, consentAfterChange,
  phoneLookupVariants, samePhone, codeText,
} from '../api/_phone-verification.js';

const read = (f) => readFileSync(f, 'utf8');

// ── 1. Codes ─────────────────────────────────────────────────────────────────
for (let i = 0; i < 200; i++) assert.match(newCode(), /^\d{6}$/, 'a code is six digits');
const stored = hashCode('042917');
assert.ok(!stored.includes('042917'), 'the code itself is never stored');
assert.ok(codeMatches('042917', stored), 'the right code matches');
assert.ok(codeMatches(' 042 917 ', stored), 'spaces typed in a code are ignored');
assert.ok(!codeMatches('042918', stored), 'a wrong code does not match');
assert.ok(!codeMatches('', stored) && !codeMatches('042917', ''), 'nothing matches nothing');
assert.notEqual(hashCode('042917'), hashCode('042917'), 'each code is salted');

// ── 2. Sending limits ────────────────────────────────────────────────────────
const t0 = Date.parse('2026-10-12T15:00:00Z');
assert.deepEqual(sendDecision(null, t0).ok, true, 'a first code is sent');
const justSent = { last_sent_at: new Date(t0).toISOString(), window_started_at: new Date(t0).toISOString(), send_count: 1 };
const tooSoon = sendDecision(justSent, t0 + RESEND_COOLDOWN_MS - 1000);
assert.equal(tooSoon.ok, false, 'a new code waits for the cooldown');
assert.equal(tooSoon.status, 429);
assert.match(tooSoon.error, /^Wait \d+ seconds, then send a new code\.$/);
const again = sendDecision(justSent, t0 + RESEND_COOLDOWN_MS);
assert.equal(again.ok, true);
assert.equal(again.sendCount, 2, 'sends inside the hour are counted');
const capped = { last_sent_at: new Date(t0 + 5 * 60000).toISOString(), window_started_at: new Date(t0).toISOString(), send_count: MAX_SENDS_PER_WINDOW };
assert.equal(sendDecision(capped, t0 + 10 * 60000).ok, false, 'no more than the hourly limit');
const fresh = sendDecision(capped, t0 + SEND_WINDOW_MS + 1);
assert.equal(fresh.ok, true, 'the limit resets after the hour');
assert.equal(fresh.sendCount, 1);

// ── 3. Checking a code ───────────────────────────────────────────────────────
const pending = { code_hash: hashCode('551204'), expires_at: new Date(t0 + CODE_TTL_MS).toISOString(), attempts: 0 };
assert.equal(verifyDecision(null, '551204', t0).status, 404, 'no code was sent');
assert.equal(verifyDecision(pending, '551204', t0).ok, true, 'the right code confirms');
assert.equal(verifyDecision(pending, '551204', t0 + CODE_TTL_MS).status, 410, 'an expired code is refused');
const wrong = verifyDecision(pending, '000000', t0);
assert.equal(wrong.ok, false);
assert.equal(wrong.wrongCode, true, 'a wrong code counts as a try');
assert.equal(verifyDecision({ ...pending, attempts: MAX_ATTEMPTS }, '551204', t0).status, 429, 'after the last try even the right code needs a new send');
assert.match(verifyDecision({ ...pending, attempts: MAX_ATTEMPTS - 1 }, '000000', t0).error, /Too many tries/, 'the last wrong try says to send a new code');

// ── 4. Job-text consent follows only if it was given ─────────────────────────
const now = new Date(t0);
assert.deepEqual(consentAfterChange({ sms_consent_at: '2026-09-01T00:00:00Z', sms_opted_out_at: null }, now),
  { sms_consent_at: now.toISOString(), sms_consent_source: 'phone_change_verified' }, 'texts on: consent re-recorded for the confirmed number');
assert.deepEqual(consentAfterChange({ sms_consent_at: null, sms_opted_out_at: null }, now), {}, 'texts never turned on stay off');
assert.deepEqual(consentAfterChange({ sms_consent_at: '2026-09-01T00:00:00Z', sms_opted_out_at: '2026-09-02T00:00:00Z' }, now), {}, 'a STOP is never undone by a number change');

// ── 5. Numbers ───────────────────────────────────────────────────────────────
assert.deepEqual(phoneLookupVariants('(512) 555-0142'),
  ['+15125550142', '5125550142', '15125550142', '512-555-0142', '(512) 555-0142'], 'every stored form is found');
assert.ok(samePhone('512-555-0142', '+15125550142'), 'formatting alone is not a change');
assert.ok(!samePhone('512-555-0142', '512-555-0143'));
assert.ok(!samePhone('', ''), 'two blanks are not the same number');
assert.ok(codeText('123456').length <= 120, 'the code text leaves room for the opt-out line in one segment');

// ── 6. The endpoint ──────────────────────────────────────────────────────────
const endpoint = read('api/assembler/phone-verification.js');
assert.match(endpoint, /authClient\.auth\.getUser\(authorization\.slice\(7\)\)/, 'a signed-in Easer only');
assert.match(endpoint, /\.eq\('id', user\.id\)\s*\.eq\('role', 'assembler'\)/, 'scoped to the caller; no Easer id is read from the request');
assert.doesNotMatch(endpoint, /req\.body\??\.(easer|user|profile)_?[iI]d/, 'no Easer id is taken from the request');
assert.match(endpoint, /numberOnAnotherAccount\(sb, phone, profile\.id\)/, 'a number on another account is refused before sending');
assert.match(endpoint, /numberOnAnotherAccount\(sb, pending\.phone, profile\.id\)/, 'and checked again before saving');
assert.match(endpoint, /sendSms\(\{[\s\S]{0,300}body: codeText\(code\)/, 'the code goes through the one SMS sender');
assert.match(endpoint, /verifyDecision\(pending, req\.body\?\.code\)[\s\S]*\.update\(\{ phone: pending\.phone, \.\.\.consentAfterChange\(profile\) \}\)/, 'the number is written only after the code matches');
assert.doesNotMatch(endpoint, /code\b[^\n]*console\.(log|error)\([^)]*\bcode\b/, 'the code is never logged');

// ── 7. The database refuses a self-made change ───────────────────────────────
const migration = read('api/migrations/109_easer_phone_verification.sql');
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.easer_phone_verifications/);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE ALL ON TABLE public\.easer_phone_verifications FROM PUBLIC, anon, authenticated/);
assert.match(migration, /IF auth\.role\(\) = 'service_role' OR auth\.uid\(\) IS NULL THEN\s*RETURN NEW;/, 'the server and the console are not held to the code');
assert.match(migration, /right\(regexp_replace\(COALESCE\(NEW\.phone, ''\), '\[\^0-9\]', '', 'g'\), 10\)/, 'formatting alone is not a change');
assert.match(migration, /BEFORE UPDATE OF phone ON public\.profiles/);

// ── 8. Website and app change the number only through the code ───────────────
const web = read('assembler/profile.html');
assert.doesNotMatch(web, /const updates = \{\s*phone:/, 'the website profile save never writes the phone');
assert.match(web, /fetch\('\/api\/assembler\/phone-verification'/);
assert.match(web, /autocomplete="one-time-code"/, 'the code field accepts the texted code');
assert.match(web, /if \(phoneChanged\) \{[\s\S]{0,200}await sendPhoneCode\(phone\)/, 'a new number goes to the code step');

const store = read('mobile/ios/App/App/EaserStore.swift');
const views = read('mobile/ios/App/App/EaserAccountViews.swift');
const saveDetails = store.slice(store.indexOf('func saveDetails('), store.indexOf('func sendPhoneCode('));
assert.ok(saveDetails.length > 0 && !/updates\["phone"\]/.test(saveDetails), 'the app details save never writes the phone');
assert.match(store, /"\/api\/assembler\/phone-verification", body: \["action": "send", "phone": phone\]/);
assert.match(store, /"\/api\/assembler\/phone-verification", body: \["action": "verify", "code": code\]/);
assert.match(views, /NavigationLink \{ PhoneChangeView\(\) \}/, 'the Phone row opens the code flow');
assert.match(views, /\.textContentType\(\.oneTimeCode\)/, 'iPhone offers the texted code');

// ── 9. The real handler, end to end, against an in-memory database ──────────
// No network, no live database, no text is sent: the SMS sender is a double
// that records what would have gone out.
const rules = await import('../api/_phone-verification.js');
const phoneHelpers = await import('../api/_phone.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const handlerSource = endpoint
  .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
  .replace(/export default async function/, 'async function');

function memoryDb(seed) {
  const rows = structuredClone(seed);
  return {
    rows,
    from(table) {
      rows[table] ||= [];
      let op = 'select', payload = null, conflict = null, limit = Infinity;
      const preds = [];
      const run = () => {
        const matches = rows[table].filter(r => preds.every(p => p(r)));
        if (op === 'upsert') {
          const existing = rows[table].find(r => r[conflict] === payload[conflict]);
          if (existing) Object.assign(existing, payload); else rows[table].push({ ...payload });
          return { data: null, error: null };
        }
        if (op === 'update') { matches.forEach(r => Object.assign(r, payload)); return { data: matches, error: null }; }
        if (op === 'delete') { rows[table] = rows[table].filter(r => !matches.includes(r)); return { data: null, error: null }; }
        return { data: matches.slice(0, limit), error: null };
      };
      const q = {
        select() { return q; },
        eq(f, v) { preds.push(r => r[f] === v); return q; },
        neq(f, v) { preds.push(r => r[f] !== v); return q; },
        in(f, vs) { preds.push(r => vs.includes(r[f])); return q; },
        limit(n) { limit = n; return q; },
        upsert(obj, opts) { op = 'upsert'; payload = obj; conflict = opts.onConflict; return q; },
        update(obj) { op = 'update'; payload = obj; return q; },
        delete() { op = 'delete'; return q; },
        async maybeSingle() { const { data, error } = run(); return { data: (data || [])[0] || null, error }; },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return q;
    },
  };
}

async function scenario({ seed, smsOk = true, smsEnabled = true, signedIn = true }) {
  const db = memoryDb(seed);
  const texts = [];
  const deps = {
    createClient: () => ({ auth: { getUser: async () => signedIn ? { data: { user: { id: 'easer-1' } }, error: null } : { data: {}, error: new Error('bad') } } }),
    getSupabase: () => db,
    normalizeUsPhone: phoneHelpers.normalizeUsPhone,
    formatUsPhone: phoneHelpers.formatUsPhone,
    isSmsEnabled: () => smsEnabled,
    sendSms: async (msg) => { texts.push(msg); return smsOk ? { ok: true } : { ok: false, error: 'provider rejected' }; },
    ...rules,
  };
  const { handler } = await new AsyncFunction(...Object.keys(deps), `${handlerSource}\nreturn { handler };`)(...Object.values(deps));
  const call = async (body) => {
    const res = { statusCode: 0, body: null, headers: {},
      setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer token' }, body }, res);
    return res;
  };
  return { db, texts, call };
}

const easer = (extra = {}) => ({ id: 'easer-1', role: 'assembler', phone: '+15125550100', sms_consent_at: '2026-09-01T00:00:00.000Z', sms_opted_out_at: null, ...extra });

{
  // Easer changes their number: code texted to the NEW number, old number stays until confirmed.
  const s = await scenario({ seed: { profiles: [easer()], easer_phone_verifications: [] } });
  const sent = await s.call({ action: 'send', phone: '512-555-0177' });
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.phone, '512-555-0177');
  assert.equal(s.texts.length, 1);
  assert.equal(s.texts[0].recipient.phone, '+15125550177', 'the code goes to the new number');
  assert.equal(s.db.rows.profiles[0].phone, '+15125550100', 'the number on file is unchanged until the code is entered');
  const code = s.texts[0].body.match(/\b(\d{6})\b/)[1];
  assert.ok(!JSON.stringify(s.db.rows.easer_phone_verifications).includes(code), 'the code is not stored in plain text');

  const wrongTry = await s.call({ action: 'verify', code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrongTry.statusCode, 400);
  assert.equal(s.db.rows.easer_phone_verifications[0].attempts, 1, 'a wrong try is counted');
  assert.equal(s.db.rows.profiles[0].phone, '+15125550100');

  const ok = await s.call({ action: 'verify', code });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(s.db.rows.profiles[0].phone, '+15125550177', 'the confirmed number is saved');
  assert.equal(s.db.rows.profiles[0].sms_consent_source, 'phone_change_verified', 'job texts continue on the confirmed number');
  assert.equal(s.db.rows.easer_phone_verifications.length, 0, 'the pending change is cleared');
  assert.equal((await s.call({ action: 'verify', code })).statusCode, 404, 'a used code cannot be replayed');
}
{
  // An Easer who texted STOP stays opted out after confirming a new number.
  const s = await scenario({ seed: { profiles: [easer({ sms_opted_out_at: '2026-09-05T00:00:00.000Z' })], easer_phone_verifications: [] } });
  await s.call({ action: 'send', phone: '5125550178' });
  const code = s.texts[0].body.match(/\b(\d{6})\b/)[1];
  assert.equal((await s.call({ action: 'verify', code })).statusCode, 200);
  assert.equal(s.db.rows.profiles[0].sms_consent_at, '2026-09-01T00:00:00.000Z', 'consent is not re-recorded after a STOP');
  assert.equal(s.db.rows.profiles[0].sms_opted_out_at, '2026-09-05T00:00:00.000Z');
}
{
  const s = await scenario({ seed: { profiles: [easer(), { id: 'easer-2', role: 'assembler', phone: '512-555-0199' }], easer_phone_verifications: [] } });
  const taken = await s.call({ action: 'send', phone: '(512) 555-0199' });
  assert.equal(taken.statusCode, 409, 'a number on another account is refused, in any stored format');
  assert.equal(s.texts.length, 0, 'and nothing is texted');
  assert.equal((await s.call({ action: 'send', phone: '512 555 0100' })).statusCode, 400, 'the current number is not a change');
  assert.equal((await s.call({ action: 'send', phone: '555-0100' })).statusCode, 400, 'an incomplete number is refused');
  assert.equal((await s.call({ action: 'nope' })).statusCode, 400);
}
{
  const s = await scenario({ seed: { profiles: [easer()], easer_phone_verifications: [] } });
  assert.equal((await s.call({ action: 'send', phone: '5125550177' })).statusCode, 200);
  const soon = await s.call({ action: 'send', phone: '5125550177' });
  assert.equal(soon.statusCode, 429, 'a second code waits for the cooldown');
  assert.equal(s.texts.length, 1);
}
{
  const failed = await scenario({ seed: { profiles: [easer()], easer_phone_verifications: [] }, smsOk: false });
  const res = await failed.call({ action: 'send', phone: '5125550177' });
  assert.equal(res.statusCode, 502, 'a text the provider refused is reported, not claimed as sent');
  assert.equal(failed.db.rows.profiles[0].phone, '+15125550100');
  assert.equal(failed.db.rows.easer_phone_verifications.length, 0, 'a failed send is not held against the Easer');
  const off = await scenario({ seed: { profiles: [easer()], easer_phone_verifications: [] }, smsEnabled: false });
  assert.equal((await off.call({ action: 'send', phone: '5125550177' })).statusCode, 503, 'no texting configured: refused with a reason');
  const anon = await scenario({ seed: { profiles: [easer()], easer_phone_verifications: [] }, signedIn: false });
  assert.equal((await anon.call({ action: 'send', phone: '5125550177' })).statusCode, 401);
  const customer = await scenario({ seed: { profiles: [easer({ role: 'customer' })], easer_phone_verifications: [] } });
  assert.equal((await customer.call({ action: 'send', phone: '5125550177' })).statusCode, 403, 'Easers only');
}

console.log('PASS Easer phone verification: a new number is texted a code and saved only once the code matches; consent follows only if given; the database refuses a self-made change; website and app use the one endpoint.');
