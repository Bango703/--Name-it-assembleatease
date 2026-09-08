#!/usr/bin/env node
// Easer job-text consent: the switch, and the rules it must not break.
//
// Until 2026-09-08 the ONLY place an Easer's SMS consent could be recorded was
// the optional checkbox on the application form. Two of four active Easers had
// never ticked it, including one doing real paid work, and there was no surface
// anywhere that could turn texts on for them. The fix is a dashboard toggle —
// and the thing that must never happen is that toggle becoming a way to
// manufacture consent nobody gave.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { smsEligibility } from '../api/_sms.js';
import { TARGET_RULES } from '../api/_announcements.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------- the gate --
const phone = '+19795550147';

assert.equal(
  smsEligibility({ phone }).ok, false,
  'A phone number on file is not consent — TCPA requires an affirmative act',
);
assert.equal(smsEligibility({ phone }).reason, 'no_consent_recorded');

assert.equal(
  smsEligibility({ phone, sms_consent_at: '2026-09-08T00:00:00.000Z' }).ok, true,
  'Recorded consent plus a valid number is eligible',
);

assert.equal(
  smsEligibility({
    phone,
    sms_consent_at: '2026-09-08T00:00:00.000Z',
    sms_opted_out_at: '2026-09-09T00:00:00.000Z',
  }).ok,
  false,
  'Opt-out must beat consent regardless of which timestamp is newer',
);
assert.equal(
  smsEligibility({
    phone,
    sms_consent_at: '2026-09-10T00:00:00.000Z',
    sms_opted_out_at: '2026-09-09T00:00:00.000Z',
  }).reason,
  'opted_out',
  'A later consent timestamp must not silently override a STOP',
);

assert.equal(smsEligibility({ sms_consent_at: '2026-09-08T00:00:00.000Z' }).reason, 'no_valid_phone');
assert.equal(smsEligibility({ phone: '555', sms_consent_at: '2026-09-08T00:00:00.000Z' }).reason, 'no_valid_phone');

// ------------------------------------------------------------- the endpoint --
const endpoint = await read('api/assembler/sms-preference.js');

// Scoped to the caller. An Easer must never be able to change anyone else's
// consent, so no identifier may come from the request.
assert.match(endpoint, /\.eq\('id', user\.id\)[\s\S]*?\.eq\('role', 'assembler'\)/,
  'Reads must be scoped to the authenticated Easer');
assert.ok(
  endpoint.split('.update(')[1]?.includes(".eq('id', user.id)"),
  'The update must be scoped to the authenticated Easer',
);
assert.doesNotMatch(endpoint, /req\.body\?\.(id|userId|profileId|assemblerId)/,
  'No identifier may be taken from the request body');

// Consent is a server timestamp, exactly as the application form records it.
assert.match(endpoint, /sms_consent_at: now/, 'Consent must use a server-generated timestamp');
assert.doesNotMatch(endpoint, /req\.body\?\.(sms_consent_at|consentAt|timestamp)/,
  'The browser must never supply the consent timestamp');
assert.match(endpoint, /sms_consent_source: 'easer_dashboard'/,
  'Dashboard consent must be distinguishable from application consent');

// Turning texts off has to write the same column a carrier STOP writes, or the
// two records of the same fact will disagree.
assert.match(endpoint, /sms_opted_out_at: now/, 'Opting out must set sms_opted_out_at');
assert.match(endpoint, /sms_opted_out_at: null/, 'Opting back in must clear the opt-out');

// A number is required before consent means anything.
assert.match(endpoint, /NO_PHONE_ON_FILE/, 'Consent without a phone number must be refused');

// ------------------------------------------------ no silent unconfigured send --
const sms = await read('api/_sms.js');
const unconfigured = sms.slice(sms.indexOf('if (!isSmsEnabled())'), sms.indexOf('const eligible ='));
assert.match(unconfigured, /logSms\(/,
  'An unconfigured send must be recorded, not dropped silently — that is how '
  + 'TELNYX_FROM_NUMBER stayed unset in production with nothing reporting it');
assert.match(unconfigured, /errorText: 'sms_not_configured'/);

// ------------------------------------------------------------------- the UI --
const profile = await read('assembler/profile.html');
assert.match(profile, /id="sms-pref-toggle"/, 'The profile page must expose the toggle');
assert.match(profile, /\/api\/assembler\/sms-preference/, 'The toggle must call the consent endpoint');
// Article 16: the switch reflects a server-confirmed result, never the click.
assert.match(profile, /toggle\.checked = !!state\.enabled/,
  'The toggle must be rendered from the server response');
assert.match(profile, /toggle\.checked = !wanted/,
  'A failed save must put the toggle back, not leave it showing a state that was never saved');
assert.match(profile, /Reply STOP/, 'The opt-out instruction must be shown next to the switch');

// The env file must name both settings, since omitting the from-number is what
// left SMS silently switched off.
const envExample = await read('.env.example');
assert.match(envExample, /^TELNYX_API_KEY=/m);
assert.match(envExample, /^TELNYX_FROM_NUMBER=/m);


// ------------------------------------------------- the prompt to turn it on --
// Having the switch is not enough: nobody knew to look for it. The announcement
// engine asks, and the rule below decides who gets asked.
const rule = TARGET_RULES.sms_consent_missing;
assert.ok(rule, 'sms_consent_missing rule must exist');

const approved = { status: 'active', application_status: 'approved', phone };

assert.equal(rule.incomplete(approved), true,
  'An approved Easer with a phone and no consent has never been asked, so ask');

// The single most important thing this rule must never do.
assert.equal(
  rule.incomplete({ ...approved, sms_opted_out_at: '2026-09-08T00:00:00.000Z' }), false,
  'Never re-ask someone who opted out - that is what the opt-out is for',
);

assert.equal(rule.incomplete({ ...approved, sms_consent_at: '2026-09-08T00:00:00.000Z' }), false,
  'Do not ask someone who already said yes');
assert.equal(rule.incomplete({ ...approved, phone: '' }), false,
  'Do not ask someone with no number to text');
assert.equal(rule.incomplete({ ...approved, status: 'suspended' }), false,
  'Do not ask a suspended Easer');
assert.equal(rule.incomplete({ ...approved, application_status: 'applied' }), false,
  'Do not ask before approval');

// The banner reads a profile the endpoint selected. A column missing there means
// the rule can never fire, which is a silent no-op rather than an error.
const requiredActions = await read('api/assembler/required-actions.js');
for (const column of ['phone', 'sms_consent_at', 'sms_opted_out_at']) {
  assert.ok(requiredActions.includes(column),
    `required-actions.js must select ${column} or the SMS rule never fires`);
}

const migration = await read('api/migrations/093_easer_sms_consent_announcement.sql');
assert.match(migration, /'sms_consent_missing'/, 'Migration must target the rule');
assert.match(migration, /false,/, 'The announcement must not block offers');
assert.doesNotMatch(migration, /UPDATE\s+public\.profiles/i,
  'A migration must never write consent on an Easer behalf');

// Owner view: reachability comes from the sender's own gate, not a second guess.
const ownerReadiness = await read('api/owner/easer-readiness.js');
assert.match(ownerReadiness, /smsEligibility\(profile\)/,
  'Owner reachability must reuse smsEligibility, not reimplement it');
assert.match(ownerReadiness, /jobTexts: jobTextStatus\(profile\)/);
assert.match(ownerReadiness, /replied STOP/, 'The owner must see WHY someone is unreachable');


// --------------------------------------------- applying enrols the applicant --
// Job dispatch happens by text, so it is no longer an optional box almost nobody
// ticked. It stays an affirmative act (submitting) and a server-recorded
// timestamp; the browser supplies neither a flag nor a time it could tamper with.
const applyServer = await read('api/assembler/apply.js');
assert.match(applyServer, /sms_consent_at: new Date\(\)\.toISOString\(\)/,
  'Applying must record consent server-side');
assert.match(applyServer, /sms_consent_source: 'easer_application'/);
assert.doesNotMatch(applyServer, /req\.body\?\.smsConsent/,
  'The browser must not decide whether consent was given');

const applyForm = await read('assembler/apply.html');
// The applicant has to SEE it before they submit, or it is not consent.
assert.match(applyForm, /Job offers are sent by text/,
  'The form must disclose the enrolment above the submit button');
assert.match(applyForm, /Reply STOP/, 'The form must show how to stop texts');
assert.doesNotMatch(applyForm, /id="sms-consent"/,
  'The optional checkbox is gone; nothing should still reference it');
assert.doesNotMatch(applyForm, /still work without it/,
  'Old optional-era copy must not contradict the new notice');

console.log('PASS Easer SMS: consent gate, endpoint scoping, no silent sends, UI truth, opt-in prompt, owner reachability, application enrolment');
