#!/usr/bin/env node
// Three numbers, three jobs (owner, 2026-11-09). The business number is for
// people reaching AssembleAtEase; every automatic update comes from the text
// number once it is approved and switched on; job calls never text. A reply in
// the owner's Messages view goes back from the number the person texted.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { smsLines, smsLineFor } from '../api/_sms.js';
import { conversationReplyLineNumber, isMissingLineNumberColumn } from '../api/_sms-conversations.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const BUSINESS = '+19792325139';
const TEXT = '+18777484603';
const base = { TELNYX_FROM_NUMBER: BUSINESS, TELNYX_MESSAGING_PROFILE_ID: 'profile-business' };
const on = { ...base, TELNYX_UPDATES_NUMBER: '877-748-4603', TELNYX_UPDATES_PROFILE_ID: 'profile-text' };

// Which number sends.
{
  const before = smsLines(base);
  assert.equal(before.separate, false);
  assert.deepEqual([before.updates.number, before.updates.profileId], [BUSINESS, 'profile-business'], 'before the switch, updates keep coming from the business number: nothing goes unsent');
  const after = smsLines(on);
  assert.equal(after.separate, true);
  assert.deepEqual([after.updates.number, after.updates.profileId], [TEXT, 'profile-text'], 'after the switch, updates come from the text number through its own profile');
  assert.deepEqual([after.business.number, after.business.profileId], [BUSINESS, 'profile-business']);
  assert.equal(smsLines({ ...base, TELNYX_UPDATES_NUMBER: TEXT }).separate, false, 'a number without its messaging profile is not switched on');
  assert.equal(smsLines({ ...base, TELNYX_UPDATES_NUMBER: BUSINESS, TELNYX_UPDATES_PROFILE_ID: 'x' }).separate, false, 'the business number is never the text number');
  assert.equal(smsLineFor(TEXT, on).number, TEXT, 'a reply to someone who texted the text number goes back from it');
  assert.equal(smsLineFor(BUSINESS, on).number, BUSINESS, 'a reply to someone who texted the business number goes back from it');
  assert.equal(smsLineFor(null, on).number, BUSINESS, 'unknown: the business number');
  assert.equal(smsLineFor('+15126314664', on).number, BUSINESS, 'the job-call number never sends a text');
}
console.log('PASS numbers: updates from the text number once switched on, the business number until then; replies from the number texted');

// Every automatic text uses the sender default; only the owner's reply names a number.
{
  const sms = read('api/_sms.js');
  assert.match(sms, /const line = from \? null : smsLines\(\)\.updates;/);
  assert.match(sms, /from: String\(from \|\| line\?\.number \|\| process\.env\.TELNYX_FROM_NUMBER \|\| ''\)\.trim\(\),/);
  assert.match(sms, /const profileId = String\(messagingProfileId \|\| line\?\.profileId \|\| process\.env\.TELNYX_MESSAGING_PROFILE_ID \|\| ''\)\.trim\(\);/);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      const rel = join(dir, name).replace(/\\/g, '/');
      if (statSync(new URL(`../${rel}`, import.meta.url)).isDirectory()) { if (name !== 'migrations') walk(rel); continue; }
      if (rel.endsWith('.js')) files.push(rel);
    }
  };
  walk('api');
  const namingANumber = files.filter((f) => f !== 'api/_sms.js' && /sendSms\(\{[\s\S]{0,400}?\bfrom: /.test(read(f)));
  assert.deepEqual(namingANumber, ['api/owner/sms-messages.js'], 'only the owner reply chooses a number; every automatic text takes the text-number default');
  assert.doesNotMatch(sms, /TELNYX_PRIVATE_LINE_NUMBERS/, 'the job-call number is never a sender');
}
console.log('PASS senders: every automatic text takes the text-number default; only the owner reply chooses a number');

// The inbox remembers the number, and keeps working before migration 128.
{
  assert.equal(isMissingLineNumberColumn({ code: '42703', message: 'column "line_number" of relation "sms_messages" does not exist' }), true);
  assert.equal(isMissingLineNumberColumn({ code: 'PGRST204', message: "Could not find the 'line_number' column of 'sms_messages' in the schema cache" }), true);
  assert.equal(isMissingLineNumberColumn({ code: '23505', message: 'duplicate key' }), false);
  const sbWith = (result) => ({ from() { const q = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: async () => result }; return q; } });
  assert.equal(await conversationReplyLineNumber(sbWith({ data: [{ line_number: TEXT }], error: null }), 'c1'), TEXT);
  assert.equal(await conversationReplyLineNumber(sbWith({ data: [], error: null }), 'c1'), null, 'never texted: the business number');
  assert.equal(await conversationReplyLineNumber(sbWith({ data: null, error: { code: '42703', message: 'line_number' } }), 'c1'), null, 'before migration 128: the business number');
  const inbox = read('api/_sms-conversations.js');
  assert.match(inbox, /if \(error && lineNumber && isMissingLineNumberColumn\(error\)\) \{\s*\/\/[^\n]*\n\s*delete row\.line_number;/, 'saved without the number rather than lost');
  const migration = read('api/migrations/128_sms_line_number.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS line_number TEXT;/);
  assert.match(migration, /VALUES \(128, 'sms_line_number'\)/);
}
console.log('PASS inbox: each text records its number; replies use it; nothing breaks before migration 128');

// Inbound on any number, labelled for the owner; the reply comes from it.
{
  const hook = read('api/webhooks/telnyx.js');
  assert.match(hook, /const lineNumber = normalizeUsPhone\(payload\?\.to\?\.\[0\]\?\.phone_number/);
  assert.match(hook, /subject: `New text to the \$\{lineLabel\} \(\$\{lineDisplay\}\) from/, 'the owner email says which line was texted');
  assert.doesNotMatch(hook, /New text to \(979\) 232-5139/, 'no hardcoded business number');
  assert.match(hook, /occurredAt: stamp,\s*lineNumber,\s*\}\);/);
  const owner = read('api/owner/sms-messages.js');
  assert.match(owner, /const line = smsLineFor\(await conversationReplyLineNumber\(sb, conversation\.id\)\);/);
  assert.match(owner, /from: line\.number \|\| null,\s*messagingProfileId: line\.profileId \|\| null,/);
  assert.match(read('api/webhooks/telnyx-private-text.js'), /import handler from '\.\/telnyx\.js';/, 'the text number\'s first webhook address is the same inbox handler');
}
console.log('PASS replies: texts to either number land in Messages, labelled; the answer goes back from the number texted');

console.log('\nThree-number text tests passed.');
