#!/usr/bin/env node

/**
 * "Could not mark 1 message as read — the badge will stay until this clears."
 *
 * The owner saw that on a booking whose customer thread was empty, with no way
 * to clear it and no stated cause. The unread row was an Easer release request
 * on a cancelled booking: visible to the count query, untouched by the write.
 *
 * The server had already captured the reason in `readError`. The dashboard threw
 * it away and printed a sentence nobody can act on.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const api = await fs.readFile(new URL('../api/booking/message.js', import.meta.url), 'utf8');
const ui = await fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

// ── A silent no-op is reported, not swallowed ───────────────────────────────
{
  assert.ok(/markedRead === 0 && unreadIds\.length > 0/.test(api),
    'an update that changes nothing while rows are unread must be detected');
  assert.ok(/matched no rows/.test(api), 'and must say exactly that');
  assert.ok(/needs investigation, not a retry/.test(api),
    'it must tell the owner retrying will not help — that is the actionable part');
  console.log('PASS an update that succeeds but changes nothing is reported as a fault');
}

// ── The server's reason reaches the owner ───────────────────────────────────
{
  assert.ok(/readError,/.test(api), 'the server must return its reason');
  assert.ok(/data\.readError/.test(ui), 'the dashboard must surface it');
  assert.ok(/The server gave no reason\./.test(ui),
    'and must say so honestly when there is none, rather than inventing one');
  // The old unactionable sentence must not survive on its own.
  assert.ok(!/as read — the badge will stay until this clears\./.test(ui),
    'the causeless message must be gone — a generic message where a specific one exists is a defect');
  console.log('PASS the owner is told the actual reason, or told there is none');
}

// ── The badge still never lies ──────────────────────────────────────────────
{
  // The original fix here was to stop clearing the badge optimistically. That
  // must survive: a badge cleared on screen and still unread in the database is
  // how this became invisible in the first place.
  assert.ok(/stillUnread === 0/.test(ui),
    'the badge must clear only on a server-confirmed zero, never on the thread rendering');
  assert.ok(/count: 'exact', head: true/.test(api),
    'the remaining count must be read from the database after the write, not inferred');
  console.log('PASS the badge still clears only from a confirmed server count');
}

console.log('\nMessage read-state truth tests passed.');
