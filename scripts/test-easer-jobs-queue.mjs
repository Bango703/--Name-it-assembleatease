import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const jobsPage = await readFile(new URL('../assembler/my-assignments.html', import.meta.url), 'utf8');
const assignmentsApi = await readFile(new URL('../api/booking/my-assignments.js', import.meta.url), 'utf8');

assert.match(jobsPage, /data-filter="scheduled"[^>]*>Scheduled/,
  'Jobs must distinguish accepted scheduled work.');
assert.match(jobsPage, /data-filter="in_progress"[^>]*>In Progress/,
  'Jobs must distinguish work that has actually started.');
assert.doesNotMatch(jobsPage, /data-filter="(?:active|upcoming)"/,
  'Ambiguous Active and Upcoming filters must not return.');
assert.match(jobsPage, /function isScheduledAssignment\(b\)[\s\S]*b\.status === 'confirmed'/,
  'Scheduled must be driven by accepted confirmed booking truth.');
assert.match(jobsPage, /function isInProgressAssignment\(b\)[\s\S]*LIVE_STATUSES\.includes\(b\.status\)/,
  'In Progress must use the existing live booking statuses.');

assert.match(assignmentsApi, /\.from\('booking_items'\)[\s\S]*item_name, quantity, is_add_on/,
  'The queue requires real booking-item scope from the authenticated assignments API.');
assert.match(jobsPage, /function physicalWorkItem\(item\)[\s\S]*exactPack[\s\S]*quantity \*= Number\(exactPack\[1\]\)/,
  'Per-item pack sizes must become physical workload quantities.');
assert.match(jobsPage, /queueWorkloadSummary\(b\._booking_items \|\| \[\]\)/,
  'Cards must summarize the real booking workload.');
assert.match(jobsPage, /Trampoline Move & Reassembly/,
  'Internal trampoline service labels must be translated for Easers.');

assert.match(jobsPage, /function formatJobAddress\(rawAddress\)/,
  'Jobs need a readable local address formatter.');
assert.doesNotMatch(jobsPage, /APP\.formatAddress\(b\.address\)/,
  'Job cards and details must not force accepted-job addresses to all caps.');
assert.match(jobsPage, /e-job-card-chevron/,
  'Cards need a visible open-details cue.');
assert.doesNotMatch(jobsPage, /renderPipeline5|card-help-btn/,
  'Queue cards must leave workflow actions and support inside job details.');
assert.match(jobsPage, /role="button" tabindex="0" aria-label=/,
  'Non-offer cards must be keyboard discoverable.');
assert.match(jobsPage, /addEventListener\('keydown'[\s\S]*e\.key !== 'Enter'[\s\S]*e\.key !== ' '/,
  'Whole-card access must work by keyboard as well as tap.');

assert.doesNotMatch(jobsPage, /function timeAgo\(/,
  'Completed cards must not drift into aging relative-day labels.');
assert.match(jobsPage, /scheduleParts\.push\('Completed ' \+ formatDate/,
  'Completed cards must show a stable calendar date.');
assert.match(jobsPage, /queuePayoutCents\(b, isCompleted\)/,
  'Cards must use one payout resolver for estimates and final earnings.');

console.log('Easer Jobs queue checks passed');
