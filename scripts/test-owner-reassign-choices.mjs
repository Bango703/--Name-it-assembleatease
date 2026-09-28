#!/usr/bin/env node
// Reassign has to have someone to reassign to.
//
// THE BUG. renderAssignSection branches on whether the booking already has an
// Easer. The assigned branch drew the "Reassign" button and hid the controls;
// the UNASSIGNED branch was the only one that ever filled the dropdown. So on
// every assigned booking, clicking Reassign revealed an empty list, and the
// Assign button stayed disabled because it only enables on the select's change
// event — which cannot fire with nothing to choose.
//
// It read as "I cannot reassign an Easer on an accepted job". Acceptance had
// nothing to do with it: any assigned booking behaved the same way.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

// ── One builder, used by both branches ──────────────────────────────────────
// Two copies drift, and the two paths disagree about who is selectable.
assert.match(ui, /function fillAssignChoices\(choices, emptyLabel\)/,
  'option building must live in one function');
const calls = ui.match(/fillAssignChoices\(/g) || [];
assert.ok(calls.length >= 3, `both branches must call it (found ${calls.length} references incl. the definition)`);

// ── The assigned branch fills the list ──────────────────────────────────────
// Anchored inside renderAssignSection. There is another `if (b.assembler_id)`
// elsewhere in the file, and matching the first one tests the wrong block.
const renderStart = ui.indexOf('function renderAssignSection');
assert.notEqual(renderStart, -1, 'renderAssignSection must exist');
const branchStart = ui.indexOf('if (b.assembler_id) {', renderStart);
assert.notEqual(branchStart, -1, 'the assigned branch must exist');
const section = ui.slice(branchStart, ui.indexOf('} else {', branchStart));
assert.match(section, /fillAssignChoices\(/,
  'the assigned branch must populate the dropdown, not only draw the Reassign button');
assert.match(section, /a\.id !== b\.assembler_id/,
  'the Easer already on the job must be excluded — picking them is a write and a notification for nothing');
// Hidden until Reassign is clicked, but built either way.
assert.match(section, /controls\.style\.display = 'none'/,
  'the controls still start hidden; Reassign reveals them');

// ── An empty list must say so ───────────────────────────────────────────────
// A silently empty dropdown is the same failure in a quieter form.
assert.match(section, /No other eligible Easer is available right now\./,
  'with nobody to hand it to, the reason must be on screen');
assert.match(ui, /if \(!choices\.length\) \{[\s\S]{0,140}esc\(emptyLabel\)/,
  'the builder must render the empty label rather than an empty select');

// ── Reassign only reveals; it never builds ──────────────────────────────────
// This is the assumption that made the bug invisible: the button looked like
// it opened a working control.
const toggle = ui.slice(ui.indexOf('window.toggleReassign = function()'), ui.indexOf('window.toggleReassign = function()') + 400);
assert.doesNotMatch(toggle, /innerHTML/,
  'toggleReassign must not build options, so the list has to exist before it runs');
assert.match(toggle, /controls\.style\.display = controls\.style\.display === 'none' \? 'flex' : 'none'/,
  'it toggles visibility and nothing else');

// ── And the request still says it is a reassignment ─────────────────────────
assert.match(ui, /isReassign = this\.dataset\.reassign === 'true' \|\| !!\(assignTarget && assignTarget\.assembler_id\)/,
  'reassign must be derived from the booking, not only from having clicked the button');
assert.match(ui, /if \(isReassign\) body\.reassign = true;/,
  'the server refuses a reassignment that does not declare itself');

console.log('PASS owner reassign: the dropdown is built for assigned bookings too, excludes the current Easer, and says so when there is nobody else');
