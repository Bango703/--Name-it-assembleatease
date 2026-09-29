#!/usr/bin/env node
// Every Easer application failed on 2026-09-29 with
//   "We could not save your application. Nothing was submitted"
// The handler writes application_attribution (migration 100). Production had
// not run migration 100, and the "retry without attribution" fallback never
// fired: it recognized Postgres's 42703 but Supabase's API answers PGRST204
// "Could not find the 'application_attribution' column of 'profiles' in the
// schema cache". Its retry also branched on the email lookup (existingProfile)
// while the first write branched on the id lookup (profileForThisAuthUser), so
// a trigger-created profile would have been INSERTED again on retry.
//
// The earlier test only checked that the fallback was mentioned in the source.
// This one feeds it the error production actually returned.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMissingAttributionColumn } from '../api/_attribution.js';

// The exact error from the production log
const production = { code: 'PGRST204', details: null, hint: null, message: "Could not find the 'application_attribution' column of 'profiles' in the schema cache" };
assert.equal(isMissingAttributionColumn(production), true, 'PostgREST missing-column error must trigger the fallback');

// Postgres form still recognized
assert.equal(isMissingAttributionColumn({ code: '42703', message: 'column "application_attribution" of relation "profiles" does not exist' }), true);
assert.equal(isMissingAttributionColumn({ code: 'PGRST204', message: "Could not find the 'booking_attribution' column of 'bookings' in the schema cache" }), true);

// Other failures must still fail loudly, never silently drop data
assert.equal(isMissingAttributionColumn({ code: 'PGRST204', message: "Could not find the 'phone' column of 'profiles' in the schema cache" }), false, 'only the attribution column may be dropped');
assert.equal(isMissingAttributionColumn({ code: '23505', message: 'duplicate key value violates unique constraint "profiles_pkey"' }), false);
assert.equal(isMissingAttributionColumn(null), false);

// The retry must take the same update/insert branch as the first write
const src = readFileSync('api/assembler/apply.js', 'utf8');
const retry = src.slice(src.indexOf('if (profileError && isMissingAttributionColumn(profileError))'), src.indexOf("console.error('Profile write error:'"));
assert.match(retry, /if \(profileForThisAuthUser\)/, 'retry must branch on the id lookup, like the first write');
assert.doesNotMatch(retry, /if \(existingProfile\)/, 'the email lookup misses trigger-created profiles');

console.log('PASS apply missing-column fallback: PGRST204 and 42703 recognized, only attribution dropped, retry branch matches.');
