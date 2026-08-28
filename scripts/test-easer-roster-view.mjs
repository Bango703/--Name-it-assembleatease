#!/usr/bin/env node

/**
 * Suspended, deactivated and rejected Easers are history, not roster.
 *
 * The default Easer tab showed every profile ever created. Two suspended pros
 * and a run of rejected test applications made the list read as if five people
 * were available when exactly one was — on a platform whose single real
 * constraint is supply, that is the most misleading number on the screen.
 *
 * They are hidden, not deleted: each status keeps its own tab, so nothing
 * becomes unreachable.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ui = await fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

// ── Off-roster statuses are excluded from the default view ──────────────────
{
  assert.ok(ui.includes("var OFF_ROSTER = ['suspended', 'deactivated', 'rejected']"),
    'the off-roster statuses must be named in one place');
  assert.ok(ui.includes("if (f === 'all') filtered = allAssemblerProfiles.filter(onRoster)"),
    'the default tab must exclude off-roster accounts');
  console.log('PASS the default view shows only Easers who can actually work');
}

// ── Tier tabs too: a suspended "elite" is not an elite you can dispatch ─────
{
  // Plain string matching, not regex: a backslash inside a template literal is an
  // escape, so `\(a\)` silently became a capture group and the check passed on
  // nothing. Same trap that produced a green guard earlier in this repo.
  for (const tier of ['starter', 'professional', 'elite']) {
    assert.ok(ui.includes(`a.tier === '${tier}' && onRoster(a)`),
      `the ${tier} tab must exclude off-roster accounts`);
  }
  console.log('PASS tier tabs list dispatchable pros, not historical ones');
}

// ── Counts must match what the tab actually shows ───────────────────────────
{
  // A badge saying 5 above a list of 2 is the same class of defect as a dashboard
  // reporting delivered mail as unsent.
  assert.ok(ui.includes("s === 'all' ? allAssemblerProfiles.filter(onRoster).length"),
    'the default tab count must match its filtered list');
  assert.ok(ui.includes('a.tier === s && onRoster(a)'),
    'tier tab counts must match their filtered lists');
  console.log('PASS every tab count matches the list beneath it');
}

// ── Nothing is unreachable, and the label does not lie ─────────────────────
{
  for (const status of ['suspended', 'deactivated', 'rejected']) {
    assert.ok(ui.includes(`data-tier="${status}"`),
      `${status} must keep its own tab — hidden from the default is not gone`);
    assert.ok(ui.includes(`f === '${status}') filtered = allAssemblerProfiles.filter`),
      `the ${status} tab must still list them`);
  }
  // A tab labelled "All" that hides three accounts is a small lie, and this
  // dashboard has already been burned by views that disagreed with the database.
  assert.ok(!ui.includes('data-tier="all">All<'),
    'the default tab must not be labelled "All" while filtering');
  assert.ok(ui.includes('data-tier="all">Roster<'), 'it should say what it actually shows');
  console.log('PASS off-roster Easers stay reachable, and the tab label tells the truth');
}

console.log('\nEaser roster view tests passed.');
