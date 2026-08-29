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
  // The union tab is gone. "Roster" was exactly Active plus Pending — both of
  // which have their own tab — so it could never show anything they did not,
  // while implying it could. A tab that is always a duplicate of two others is
  // worse than no tab: it costs a click to learn it told you nothing.
  assert.ok(!ui.includes('data-tier="all"'),
    'there must be no All/Roster tab — it was a union of two tabs that both already exist');
  console.log('PASS off-roster Easers stay reachable, and no tab duplicates two others');
}

// ── Empty tabs get out of the way, but never the two that matter ───────────
// Nine tabs above a roster of two was most of this view. An empty tab is not
// information; it is a click that teaches you nothing.
{
  assert.ok(ui.includes("var ALWAYS_SHOWN = ['active', 'pending'];"),
    'the tabs that survive at zero must be named in one place');
  assert.ok(ui.includes("var hide = c === 0 && ALWAYS_SHOWN.indexOf(s) === -1;"),
    'a tab with nothing in it must hide, so the bar reflects the real roster');

  // Pending at zero must STILL show. A new applicant arriving behind a hidden
  // tab is the most expensive thing this view could conceal — supply is the
  // platform's only real constraint.
  assert.ok(/ALWAYS_SHOWN\s*=\s*\[[^\]]*'pending'/.test(ui),
    'Pending must stay visible at zero or a new applicant can arrive unseen');
  assert.ok(/ALWAYS_SHOWN\s*=\s*\[[^\]]*'active'/.test(ui),
    'Active is home and must never hide');

  // Standing on a tab that empties must not leave the list with no selection.
  assert.ok(ui.includes("if (visibleTiers.indexOf(currentTierFilter) === -1) {"),
    'a tab that vanishes under the owner must fall back to a real one');
  assert.ok(ui.includes("return renderAssemblerTable();"),
    'the fallback must re-render, and can only recurse once because Active always shows');
  console.log('PASS empty tabs hide, Active and Pending never do, and a vanishing tab lands somewhere real');
}

// ── The list opens on people who can work today ────────────────────────────
{
  assert.ok(ui.includes("var currentTierFilter = 'active';"),
    "the Easer list must default to ACTIVE — the owner's first glance should answer who can work");
  assert.ok(ui.includes('<button class="tab active" data-tier="active">Active</button>'),
    'the Active tab must be the one rendered as selected, or the highlight and the list disagree');

  // Pending must stay one tap away and keep its count, or a new applicant sits
  // unseen — on a platform whose only real constraint is supply, that is the
  // most expensive thing this view could hide.
  assert.ok(ui.includes('data-tier="pending"'), 'Pending must keep its own tab');
  assert.ok(ui.includes("s === 'pending' ? allAssemblerProfiles.filter"),
    'Pending must keep a live count so a new application is visible without switching tabs');
  console.log('PASS the list opens on Active, and a pending application still shows a count');
}

console.log('\nEaser roster view tests passed.');
