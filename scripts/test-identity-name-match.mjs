#!/usr/bin/env node
// Whose ID is it? (owner, 2026-11-22: "I just did a test and verified a whole
// name that doesn't match my ID. That's a safety issue.")
//
// Stripe Identity and Persona prove the ID is genuine and the selfie is the
// person holding it. Neither proves that person is the account holder. Before
// anyone is marked verified, the name on the ID must be the account's name and
// the date of birth 18 or older (api/_identity-outcome.js). Otherwise the Easer
// stays unverified and the owner gets both names.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  nameTokens, identityNameMatches, identityAgeYears, identityDocumentCheck, MINIMUM_EASER_AGE,
} from '../api/_identity-outcome.js';
import { identityFollowupStage } from '../api/_identity-followup.js';
import { personaDocumentOutputs } from '../api/_persona.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ── The same person passes ──────────────────────────────────────────────────
const same = [
  ['Travis Gibson', 'TRAVIS', 'GIBSON'],
  ['travis gibson', 'Travis', 'Gibson'],
  ['Travis James Gibson', 'TRAVIS JAMES', 'GIBSON'],
  ['José Hernández', 'JOSE', 'HERNANDEZ'],
  ['Luis Garcia', 'LUIS', 'GARCIA LOPEZ'],
  ['Luis Lopez', 'LUIS', 'GARCIA LOPEZ'],
  ['Mary Smith-Jones', 'MARY', 'SMITH JONES'],
  ['Shaun O’Neil', 'SHAUN', "O'NEIL"],
  ['DeAndre Wilson Jr.', 'DEANDRE', 'WILSON JR'],
  ['Guadalupe Ruiz', 'MARIA GUADALUPE', 'RUIZ'],
];
for (const [account, firstName, lastName] of same) {
  assert.equal(identityNameMatches(account, { firstName, lastName }), true, `${account} is ${firstName} ${lastName}`);
}

// ── A different person, or a name that cannot be confirmed, does not ────────
const different = [
  ['Pat Doe', 'TRAVIS', 'GIBSON', 'a different person entirely (the owner\'s test)'],
  ['Travis Smith', 'TRAVIS', 'GIBSON', 'same first name, different last name'],
  ['John Gibson', 'TRAVIS', 'GIBSON', 'same last name, different first name'],
  ['Mike Brown', 'MICHAEL', 'BROWN', 'a nickname goes to the owner'],
  ['Travis', 'TRAVIS', 'GIBSON', 'a one-word account name cannot be confirmed'],
  ['', 'TRAVIS', 'GIBSON', 'no account name'],
  ['Travis Gibson', '', 'GIBSON', 'no first name read off the ID'],
];
for (const [account, firstName, lastName, why] of different) {
  assert.equal(identityNameMatches(account, { firstName, lastName }), false, why);
}
assert.deepEqual(nameTokens('  Ana-María  de la Cruz III '), ['ana', 'maria', 'de', 'la', 'cruz']);

// ── Age ─────────────────────────────────────────────────────────────────────
const now = new Date('2026-11-22T12:00:00Z');
assert.equal(MINIMUM_EASER_AGE, 18);
assert.equal(identityAgeYears({ year: 2008, month: 11, day: 22 }, now), 18, '18 on the day');
assert.equal(identityAgeYears({ year: 2008, month: 11, day: 23 }, now), 17, 'one day short');
assert.equal(identityAgeYears(null, now), null, 'no birth date read');

// ── The whole check, with the reasons the owner sees ───────────────────────
assert.deepEqual(identityDocumentCheck('Travis Gibson', { firstName: 'TRAVIS', lastName: 'GIBSON', dob: { year: 1990, month: 1, day: 1 } }, now), { ok: true, documentName: 'TRAVIS GIBSON' });
assert.equal(identityDocumentCheck('Pat Doe', { firstName: 'TRAVIS', lastName: 'GIBSON' }, now).reason, 'name_mismatch');
assert.equal(identityDocumentCheck('Pat Doe', {}, now).reason, 'name_unreadable');
assert.equal(identityDocumentCheck('Pat Doe', { firstName: 'PAT', lastName: 'DOE', dob: { year: 2010, month: 5, day: 5 } }, now).reason, 'under_minimum_age');
assert.equal(identityDocumentCheck('Pat Doe', { firstName: 'PAT', lastName: 'DOE' }, now).ok, true, 'a missing birth date does not block on its own');

// ── Persona's ID data reaches the same check ───────────────────────────────
assert.deepEqual(personaDocumentOutputs({ included: [
  { type: 'verification/government-id', attributes: { status: 'failed', 'name-first': 'X', 'name-last': 'Y' } },
  { type: 'verification/government-id', attributes: { status: 'passed', 'name-first': 'PAT', 'name-last': 'DOE', birthdate: '1990-04-02' } },
] }), { firstName: 'PAT', lastName: 'DOE', dob: { year: 1990, month: 4, day: 2 } }, 'only a passed ID verification counts');
assert.deepEqual(personaDocumentOutputs({}), { firstName: '', lastName: '', dob: null });

// ── A held ID is not mistaken for a lost webhook ───────────────────────────
const session = { status: 'verified' };
assert.equal(identityFollowupStage({ stripe_identity_session_id: 'vs_1', id_verification_status: 'failed' }, session), 'held_for_review');
assert.equal(identityFollowupStage({ stripe_identity_session_id: 'vs_1', id_verification_status: 'pending' }, session), 'verified_unrecorded');
assert.match(read('api/cron/identity-followup.js'), /stage === 'held_for_review'\) \{ result\.skipped\.push/, 'the daily follow-up leaves a held ID to the owner');

// ── Wiring: nothing marks a provider-passed ID verified without the check ──
const stripeHook = read('api/assembler/stripe-webhook.js');
assert.match(stripeHook, /retrieve\(session\.id, \{ expand: \['verified_outputs'\] \}\)/, 'Stripe reads what it saw on the ID');
assert.match(read('api/webhook/persona.js'), /identityDocumentCheck\(profile\.full_name, personaDocumentOutputs\(/);
const outcome = read('api/_identity-outcome.js');
assert.match(outcome, /export async function recordIdentityHeldForReview[\s\S]{0,400}identity_verified: false,[\s\S]{0,80}id_verification_status: 'failed'/, 'a held ID stays unverified');
assert.doesNotMatch(outcome.slice(outcome.indexOf('export async function recordIdentityHeldForReview'), outcome.indexOf('export async function recordIdentityRetry')), /buildIdentityResumeUrl|ensureIdentityResumeToken/, 'no retry link: the same ID gives the same answer');

console.log('PASS identity name match: the ID must be the account holder (name and 18+) for Stripe and Persona, held IDs go to the owner with both names, the follow-up job leaves them alone.');
