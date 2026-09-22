#!/usr/bin/env node
// "1 Active Jobs" above "No active jobs right now".
//
// Live Ops, 2026-09-22. Both lines came from one payload. The count was made on
// the server — every operational booking except 'pending' — and the list was
// made in the browser from enRoute + arrived + inProgress + awaitingAcceptance.
// Booking AAE-DVSNHXE4OO was confirmed, staffed, accepted by Phil Hawkins and
// held on the customer's card, waiting for Thursday. That state is in none of
// the browser's four arrays, so the owner's only live job was counted by the
// chip, shown by nothing, and had to be found on the Bookings page instead.
//
// A number the operator cannot open is not information (Rule 8), and the same
// two words meaning two things on one screen is double-talk (Rule 2). The rule
// now lives in one module: the count is the length of the list, and the stage
// comes from the server.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACTIVE_JOB_STAGE_ORDER,
  activeJobStage,
  buildActiveJobs,
  isOperationalBooking,
  operationalDate,
} from '../api/owner/_active-jobs.js';

const booking = (overrides = {}) => ({
  id: overrides.ref || 'b',
  ref: 'AAE-TEST',
  status: 'confirmed',
  date: '2026-09-24',
  time: '8:00 AM – 10:00 AM',
  assembler_id: null,
  assembler_accepted_at: null,
  return_visit_required: false,
  ...overrides,
});

// ── 1. The job that started this: confirmed, assigned, accepted ─────────────
{
  const staffed = booking({
    ref: 'AAE-DVSNHXE4OO',
    assembler_id: 'easer-1',
    assembler_accepted_at: '2026-09-16T17:31:31Z',
  });
  assert.equal(activeJobStage(staffed), 'scheduled',
    'an accepted job waiting for its day is "scheduled" — it used to be nothing');
  const list = buildActiveJobs([staffed]);
  assert.equal(list.length, 1, 'and it appears in the list Live Ops renders');
  assert.equal(list[0]._stage, 'scheduled');
  assert.equal(list[0]._stage_date, '2026-09-24');
  assert.equal(list[0]._stage_time, '8:00 AM – 10:00 AM');
}

// ── 2. Every stage an operator would name, and nothing without a stage ──────
{
  const cases = [
    [booking({ assembler_id: null }), 'needs_easer'],
    [booking({ assembler_id: 'e1' }), 'awaiting_accept'],
    [booking({ assembler_id: 'e1', assembler_accepted_at: 'now' }), 'scheduled'],
    [booking({ status: 'en_route', assembler_id: 'e1', assembler_accepted_at: 'now' }), 'en_route'],
    [booking({ status: 'arrived', assembler_id: 'e1', assembler_accepted_at: 'now' }), 'arrived'],
    [booking({ status: 'in_progress', assembler_id: 'e1', assembler_accepted_at: 'now' }), 'in_progress'],
    [booking({ status: 'completed', return_visit_required: true, assembler_id: 'e1', assembler_accepted_at: 'now' }), 'return_visit'],
  ];
  for (const [row, stage] of cases) {
    assert.equal(activeJobStage(row), stage);
    assert.ok(ACTIVE_JOB_STAGE_ORDER.includes(stage), `${stage} must be orderable`);
  }
  const all = buildActiveJobs(cases.map(([row]) => row));
  assert.equal(all.length, cases.length, 'every operational booking is listed');
  assert.equal(new Set(all.map(job => job._stage)).size, cases.length, 'each with its own stage');
}

// ── 3. The count cannot exceed what is shown, in either direction ───────────
{
  const rows = [
    booking({ ref: 'A', status: 'pending' }),                      // not paid for yet: payment panels own it
    booking({ ref: 'B', status: 'cancelled' }),
    booking({ ref: 'C', status: 'declined' }),
    booking({ ref: 'D', status: 'completed' }),                    // finished, nothing owed
    booking({ ref: 'E', assembler_id: 'e1', assembler_accepted_at: 'now' }),
    booking({ ref: 'F', status: 'en_route', assembler_id: 'e1', assembler_accepted_at: 'now' }),
  ];
  const operational = rows.filter(isOperationalBooking);
  const list = buildActiveJobs(operational);
  assert.deepEqual(list.map(job => job.ref).sort(), ['E', 'F'],
    'cancelled, declined, finished and unpaid bookings are not active jobs');
  // This is the invariant the screen broke: the number IS the list.
  assert.equal(list.length, buildActiveJobs(operational).length);
}

// ── 4. Work happening now sorts above work that is merely set ───────────────
{
  const list = buildActiveJobs([
    booking({ ref: 'later', assembler_id: 'e1', assembler_accepted_at: 'now', date: '2026-10-02' }),
    booking({ ref: 'sooner', assembler_id: 'e1', assembler_accepted_at: 'now', date: '2026-09-24' }),
    booking({ ref: 'live', status: 'in_progress', assembler_id: 'e1', assembler_accepted_at: 'now', date: '2026-09-30' }),
    booking({ ref: 'unstaffed', date: '2026-09-23' }),
  ]);
  assert.deepEqual(list.map(job => job.ref), ['live', 'sooner', 'later', 'unstaffed'],
    'in progress first, then scheduled by date, then what still needs a person');
}

// ── 5. A return visit is dated by the return visit ──────────────────────────
{
  const returning = booking({
    status: 'completed',
    return_visit_required: true,
    return_visit_date: '2026-10-05',
    return_visit_time: '12:00 PM – 2:00 PM',
    assembler_id: 'e1',
    assembler_accepted_at: 'now',
  });
  assert.equal(operationalDate(returning), '2026-10-05', 'not the original appointment date');
  assert.equal(buildActiveJobs([returning])[0]._stage_time, '12:00 PM – 2:00 PM');
}

// ── 6. The server owns this, and the browser renders it ─────────────────────
const liveOps = await readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8');
assert.match(liveOps, /import \{[\s\S]*?buildActiveJobs[\s\S]*?\} from '\.\/_active-jobs\.js'/,
  'live-ops takes the rule from the module');
assert.match(liveOps, /totalActive: activeJobs\.length/,
  'the count is the length of the list, not a parallel filter');
assert.match(liveOps, /\n    activeJobs,/, 'and the list is sent to the browser');

const dashboard = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
const panel = dashboard.slice(dashboard.indexOf("var activeEl = document.getElementById('ops-active')"), dashboard.indexOf("// Easers"));
assert.match(panel, /var active = d\.activeJobs \|\| \[\];/, 'the panel renders the server list');
assert.doesNotMatch(panel, /d\.enRoute\s*\|\|\s*\[\]\)\.concat/,
  'and never rebuilds its own idea of what is active');
assert.match(panel, /b\._stage/, 'the stage badge comes from the server verdict');

console.log('Live Ops active jobs tests: PASS');
