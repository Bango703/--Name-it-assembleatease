#!/usr/bin/env node
// Onboarding links (owner, 2026-11-15: the Easer page offered "Resend Secure
// Onboarding Link" for a waitlisted applicant and the server refused with a
// vague sentence). The open applications are one list, equal to what Easer
// readiness treats as submitted, and a refusal names the state that stopped it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPEN_APPLICATION_STATUSES } from '../api/_assembler-onboarding.js';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const readiness = read('api/_easer-readiness.js');
const m = readiness.match(/const applicationSubmitted = \[([^\]]+)\]\.includes\(applicationStatus\);/);
assert.ok(m, 'readiness names its submitted application states in one place');
const readinessList = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
assert.deepEqual([...OPEN_APPLICATION_STATUSES].sort(), readinessList.sort(), 'onboarding and readiness agree on open applications');
assert.ok(OPEN_APPLICATION_STATUSES.includes('waitlist'), 'a waitlisted application can still be onboarded');

const resend = read('api/owner/resend-easer-onboarding.js');
assert.match(resend, /!OPEN_APPLICATION_STATUSES\.includes\(applicationStatus\)/);
assert.doesNotMatch(resend, /\['applied', 'pending', 'reviewing'\]/, 'no application status the platform never writes');
assert.match(resend, /Onboarding links go only to open applications\./);
assert.match(resend, /code: 'ONBOARDING_NOT_OPEN'/);
console.log('PASS onboarding open applications: one list, equal to readiness; refusals name the state.');
