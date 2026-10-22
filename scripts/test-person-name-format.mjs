#!/usr/bin/env node
// Names typed in capitals, 2026-10-06. Owner: "name format difference size" —
// "THOMAS J WILLIAMS-GIBSON" in the Easer roster beside names written normally.
// Names with no casing information are stored in ordinary capitalisation;
// names typed with their own casing are kept; signatures are never changed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePersonName } from '../api/_person-name.js';

const cases = [
  ['THOMAS J WILLIAMS-GIBSON', 'Thomas J Williams-Gibson'],
  ['santiago blake', 'Santiago Blake'],
  ["MARY O'BRIEN", "Mary O'Brien"],
  ['  JOSÉ   ÁLVAREZ ', 'José Álvarez'],
  ['Trapper Riney', 'Trapper Riney'],
  ['McDonald', 'McDonald'],
  ['DeShawn Smith', 'DeShawn Smith'],
  ['van der Berg', 'van der Berg'],
  ['J', 'J'],
  ['', ''],
];
for (const [input, expected] of cases) assert.equal(normalizePersonName(input), expected, input);
assert.equal(normalizePersonName('Jo Ann  Lee'), 'Jo Ann Lee', 'extra spaces collapse even when casing is kept');

const apply = readFileSync('api/assembler/apply.js', 'utf8');
assert.match(apply, /const displayName = normalizePersonName\(cleanName\);/);
assert.equal((apply.match(/full_name: displayName,/g) || []).length, 2, 'profile and sign-in record store the display name');
assert.match(apply, /signedName: cleanName,/, 'the contractor agreement signature is kept exactly as typed');
assert.match(readFileSync('api/owner/add-easer.js', 'utf8'), /const cleanName {2}= normalizePersonName\(fullName\);/);

const migration = readFileSync('api/migrations/105_normalize_shouted_names.sql', 'utf8');
assert.match(migration, /full_name = upper\(full_name\) OR full_name = lower\(full_name\)/, 'only names with no casing information are corrected');
assert.match(migration, /SET full_name = initcap\(/);
assert.match(migration, /DO \$\$[\s\S]*PERFORM set_config\('request\.jwt\.claim\.role', 'service_role', true\)[\s\S]*UPDATE public\.profiles[\s\S]*END\s*\$\$;/, 'runs past the profile guard as the server does, for this transaction only');
assert.doesNotMatch(migration, /contractor_agreement_signed_name|bookings/, 'signatures and bookings are not touched');
assert.match(migration, /NOTIFY pgrst, 'reload schema'/);

console.log('PASS person name format: all-caps and all-lowercase names stored in ordinary capitalisation, typed casing kept, signatures untouched.');

// ── Easer emails greet by a properly capitalised first name ────────────────
// Owner, 2026-10-22: a rejection email opened "Hi innocent,". Every greeting in
// api/assembler/update.js goes through greetingFirstName.
{
  const { greetingFirstName, buildRejectionEmail } = await import('../api/assembler/update.js');
  assert.equal(greetingFirstName('innocent Joshua'), 'Innocent');
  assert.equal(greetingFirstName('THOMAS J WILLIAMS-GIBSON'), 'Thomas');
  assert.equal(greetingFirstName('DeShawn Carter'), 'DeShawn', 'typed casing is kept');
  assert.equal(greetingFirstName(''), 'there');
  const update = readFileSync(new URL('../api/assembler/update.js', import.meta.url), 'utf8');
  assert.doesNotMatch(update, /full_name \|\| ''\)\.split\(' '\)\[0\]/, 'no greeting takes the raw first word');

  const waived = buildRejectionEmail('Innocent', 'Your application listed no competing business', false, true);
  assert.match(waived, /Hi Innocent,/);
  assert.match(waived, />Reason</);
  assert.match(waived, /listed no competing business\./, 'the reason ends as a sentence');
  assert.doesNotMatch(waived, /fee waiver|No application fee was collected/, 'a waived fee is not mentioned');
  assert.doesNotMatch(waived, /reapply after 90 days/, 'no reapply promise the system does not enforce');
  const refunded = buildRejectionEmail('Ana', '', true, false);
  assert.match(refunded, /application fee has been refunded/);
  const { EASER_APPLICATION_FEE_DISPLAY } = await import('../api/_easer-application-fee.js');
  assert.ok(refunded.includes(`Your ${EASER_APPLICATION_FEE_DISPLAY} application fee`), 'the fee comes from the fee setting');
}
console.log('PASS Easer emails: greetings capitalised; the rejection email states the reason, never the fee waiver or an unenforced reapply date.');
