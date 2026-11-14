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

// Bookings (owner console v2, 2026-11-13): the column header and every row
// share one fixed four-column rule, so each column sits at the same x.
assert.match(css, /\.bk-list-head, \.bk-row\.c-brow \{[^}]*grid-template-columns: minmax\(0, 1fr\) 128px 118px 96px/, 'header and booking rows share fixed columns');
assert.match(html, /'<div class="booking-card c-brow bk-row'/, 'the list renders console rows');
assert.match(html, /<div class="bk-list-head" aria-hidden="true"><span>Customer \/ Service<\/span><span>Date &amp; Time<\/span><span>Status<\/span><span>Amount<\/span><\/div>/, 'one header row names the four columns');

// Booking record: notices are one Notes box, not a stack of colored boxes.
assert.match(html, /var blocks = notices\.length \? \['<div class="c-notes">'/, 'notices render as one Notes box');

// Financials (owner console v2, 2026-11-13): an Overview of number cards,
// chart, breakdown, health, metrics and tables; the detailed figures sit in
// labeled groups under More. Each figure appears once. Empty warnings not drawn.
const groups = [...html.matchAll(/<div class="c-group-title">([^<]+)<\/div>/g)].map(m => m[1]);
assert.deepEqual(groups, ['Labor', 'Operating estimate', 'Customers and add-ons']);
for (const id of ['fin-total-platform-gross', 'an-gross', 'an-easer-payouts', 'an-processing-fees', 'an-sales-tax', 'an-net-profit', 'an-completed-jobs', 'an-gross-margin', 'reserve-total']) {
  assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} is shown once`);
}
assert.match(css, /#an-finance-warning:empty, #an-empty-period:empty \{ display: none !important; \}/);

console.log('PASS owner console design: console.css last, fixed-column tables, Live Ops through cTable, counts are list lengths, grouped sidebar');
