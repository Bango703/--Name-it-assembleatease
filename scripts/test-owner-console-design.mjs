#!/usr/bin/env node
// Owner console design system (owner, 2026-10-16): one set of components, so
// every column lines up and a color means the same thing on every screen.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));
const html = await read('owner/index.html');
const css = await read('owner/assets/console.css');

// The console stylesheet loads last, so it decides the look.
const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
assert.equal(links[links.length - 1], '/owner/assets/console.css', 'console.css is the last stylesheet');

// Tables have fixed columns: the same column sits at the same x on every row.
assert.match(css, /\.c-table \{[^}]*table-layout: fixed/, 'console tables use fixed column widths');
assert.match(html, /function cTable\(cols, rows, rowAttrs\)[\s\S]{0,300}<colgroup>/, 'cTable writes a colgroup');

// Every Live Ops list renders through the shared table.
const live = html.slice(html.indexOf('function renderLiveOps(d)'), html.indexOf('async function opsAction('));
for (const id of ['ops-alerts-bar', 'ops-unassigned', 'ops-active', 'ops-easers', 'ops-today']) {
  assert.ok(live.includes(`getElementById('${id}')`), `${id} is rendered`);
}
assert.ok((live.match(/cTable\(/g) || []).length >= 5, 'Live Ops lists use cTable');

// A count is the length of the list it summarises.
assert.match(live, /var alertCount = \(d\.alerts \|\| \[\]\)\.length;/, 'the sidebar badge counts the Needs you now list');
assert.match(live, /\{ label: 'Need you now', val: alerts\.length/, 'the strip counts the same list');

// Red counts only where the owner must act.
for (const id of ['nav-liveops-alerts', 'nav-inbox', 'nav-cases']) {
  assert.match(html, new RegExp(`class="nav-count is-action" id="${id}"`), `${id} is an action count`);
}

// The sidebar is grouped by job.
const labels = [...html.matchAll(/<div class="sidebar-label">([^<]+)<\/div>/g)].map(m => m[1]);
assert.deepEqual(labels, ['Run the day', 'Inbox', 'Easers', 'Money', 'Growth', 'Tools']);

// Bookings: every row on one fixed three-column grid.
assert.match(css, /\.booking-card\.c-brow \{[^}]*grid-template-columns: minmax\(0, 1fr\) 132px 124px/, 'booking rows share fixed columns');
assert.match(html, /'<div class="booking-card c-brow'/, 'the list renders console rows');

// Booking record: notices are one Notes box, not a stack of colored boxes.
assert.match(html, /var blocks = notices\.length \? \['<div class="c-notes">'/, 'notices render as one Notes box');

// Financials: tiles in labeled groups on a cell grid; empty warnings not drawn.
const groups = [...html.matchAll(/<div class="c-group-title">([^<]+)<\/div>/g)].map(m => m[1]);
assert.deepEqual(groups, ['Where the money went', 'Per job', 'Operating estimate', 'Customers and add-ons']);
assert.match(css, /#an-finance-warning:empty, #an-empty-period:empty \{ display: none !important; \}/);

console.log('PASS owner console design: console.css last, fixed-column tables, Live Ops through cTable, counts are list lengths, grouped sidebar');
