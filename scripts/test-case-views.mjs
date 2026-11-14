#!/usr/bin/env node
// Case tabs (owner console, 2026-11-13). One rule per view decides its count
// and its list; the cards agree with the summary the nav badge reads; the
// resolution figures count only finished cases from the last 30 days.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASE_VIEWS, countCaseViews, caseResolutionStats, summarizeOperationCases } from '../api/owner/cases.js';

const now = Date.parse('2026-11-13T15:00:00Z');
const rows = [
  { status: 'open', severity: 'critical', created_at: '2026-11-10T15:00:00Z' },
  { status: 'acknowledged', severity: 'high', created_at: '2026-11-10T15:00:00Z' },
  { status: 'in_progress', severity: 'normal', created_at: '2026-11-10T15:00:00Z' },
  { status: 'waiting_customer', severity: 'high', created_at: '2026-11-10T15:00:00Z' },
  { status: 'waiting_easer', severity: 'low', created_at: '2026-11-10T15:00:00Z' },
  { status: 'resolved', severity: 'critical', created_at: '2026-11-12T03:00:00Z', resolved_at: '2026-11-12T09:00:00Z' },
  { status: 'closed', severity: 'normal', created_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-01T12:00:00Z' },
  { status: 'resolved', severity: 'normal', created_at: '2026-08-01T00:00:00Z', resolved_at: '2026-08-02T00:00:00Z' },
];
const views = countCaseViews(rows);
const summary = summarizeOperationCases(rows);
assert.deepEqual(views, { all: 8, active: 5, new: 1, high_priority: 3, waiting: 2, resolved: 3 });
// The cards read the summary; the tabs read the views; they are the same rules.
assert.equal(views.active, summary.active);
assert.equal(views.new, summary.new);
assert.equal(views.high_priority, summary.highPriority);
assert.equal(views.waiting, summary.waitingCustomer + summary.waitingEaser);
assert.equal(views.resolved, summary.resolved);
assert.equal(views.all, summary.total);
// A resolved critical case is not high priority: priority is for active cases.
assert.equal(CASE_VIEWS.high_priority(rows[5]), false);

// Last 30 days: two finished (6 h and 12 h), the August one is out.
assert.deepEqual(caseResolutionStats(rows, now), { resolvedLast30Days: 2, avgHoursToResolve: 9 });
assert.deepEqual(caseResolutionStats([], now), { resolvedLast30Days: 0, avgHoursToResolve: null });

// The handler validates the view, narrows by type and priority before counting,
// and filters the list by the same view rule.
const api = readFileSync(new URL('../api/owner/cases.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
assert.match(api, /if \(viewFilter && !Object\.prototype\.hasOwnProperty\.call\(CASE_VIEWS, viewFilter\)\) \{/);
assert.match(api, /views: countCaseViews\(narrowed\),/);
assert.match(api, /if \(viewFilter && !CASE_VIEWS\[viewFilter\]\(row\)\) return false;/);
const ui = readFileSync(new URL('../owner/assets/cases.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
assert.match(ui, /params\.set\('view', state\.view \|\| 'all'\);/);
assert.match(ui, /openCaseView\(viewButton\.getAttribute\('data-case-view'\), viewButton\.classList\.contains\('kpi'\)\)/, 'a card clears the other filters, a tab keeps them');

console.log('PASS case views: one rule per tab for count and list; cards agree with the summary; 30-day resolution figures.');
