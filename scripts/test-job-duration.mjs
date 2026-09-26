#!/usr/bin/env node
// How long a job took — the math, and the three places that must carry it.
//
// The stamps existed for months and nothing read them. The risk in adding the
// reading is not the arithmetic, it is the honesty: an owner-recorded offline
// job is written straight to completed with no job_started_at, and a helper
// that quietly returns 0 for those would drag every service average toward
// zero and make the crew look faster than it is. Most of this file exists to
// pin that down.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

// Load and exercise the real shipped file, the same way the browser will.
const browser = {};
new Function('window', await read('assets/js/job-duration.js'))(browser);
const D = browser.AAE_JOB_DURATION;
assert.ok(D, 'assets/js/job-duration.js must expose window.AAE_JOB_DURATION');

const START = '2026-09-24T14:00:00Z';
const at = minutes => new Date(Date.parse(START) + minutes * 60000).toISOString();
const job = (extra = {}) => ({ service: 'Furniture Assembly', job_started_at: START, completed_at: at(90), ...extra });

// ── 1. The span ─────────────────────────────────────────────────────────────
assert.equal(D.jobDurationMs(job()), 90 * 60000);
assert.equal(D.jobDurationMs(job({ completed_at: at(15) })), 15 * 60000);

// ── 2. Missing is unknown, never zero ───────────────────────────────────────
// This is the offline job imported straight to completed by
// api/owner/create-booking.js. It has a completed_at and no start.
assert.equal(D.jobDurationMs(job({ job_started_at: null })), null, 'no start time means unknown, not instant');
assert.equal(D.jobDurationMs(job({ completed_at: null })), null, 'a running job has no duration yet');
assert.equal(D.jobDurationMs(job({ job_started_at: '' })), null);
assert.equal(D.jobDurationMs(job({ completed_at: 'not a date' })), null);
assert.equal(D.jobDurationMs(null), null);
assert.equal(D.jobDurationMs({}), null);

// A clock that runs backwards is a broken clock, not a job finished before it
// started. Reporting it as a negative duration would poison the average.
assert.equal(D.jobDurationMs(job({ completed_at: at(-30) })), null, 'a negative span is unusable');
assert.equal(D.jobDurationMs(job({ completed_at: START })), null, 'a zero span is unusable');

// ── 3. Both row shapes ──────────────────────────────────────────────────────
// The drawer reads raw booking rows (snake_case); the Insights panel reads
// finance ledger rows (camelCase). One helper has to accept both or the two
// screens drift into two answers.
assert.equal(D.jobDurationMs({ jobStartedAt: START, completedAt: at(90) }), 90 * 60000);
assert.equal(D.jobDurationMs({ job_started_at: START, completedAt: at(45) }), 45 * 60000);

// ── 4. Formatting ───────────────────────────────────────────────────────────
assert.equal(D.formatJobDuration(45 * 60000), '45m');
assert.equal(D.formatJobDuration(60 * 60000), '1h');
assert.equal(D.formatJobDuration(105 * 60000), '1h 45m');
assert.equal(D.formatJobDuration(240 * 60000), '4h');
// 59 minutes 40 seconds rounds to 60 minutes, which must read as an hour.
assert.equal(D.formatJobDuration(59.67 * 60000), '1h', 'rounding up to 60 minutes must not print "60m"');
assert.equal(D.formatJobDuration(null), null, 'null in, null out — the caller says "Not recorded"');
assert.equal(D.formatJobDuration(0), null);
assert.equal(D.formatJobDuration(-5), null);

// ── 5. The rollup reports what it could not measure ─────────────────────────
const mixed = [
  job({ completed_at: at(60) }),
  job({ completed_at: at(90) }),
  job({ completed_at: at(180) }),
  job({ job_started_at: null }),
  job({ job_started_at: null }),
];
const all = D.summarize(mixed);
assert.equal(all.count, 3, 'only timed jobs are counted');
assert.equal(all.missing, 2, 'the untimed jobs must be reported, not silently dropped');
assert.equal(D.formatJobDuration(all.medianMs), '1h 30m');
assert.equal(D.formatJobDuration(all.averageMs), '1h 50m');
assert.equal(D.formatJobDuration(all.longestMs), '3h');

// The median is the headline precisely so one job left open overnight cannot
// set the expectation for every job after it.
const withOutlier = D.summarize([...mixed, job({ completed_at: at(14 * 60) })]);
assert.equal(D.formatJobDuration(withOutlier.medianMs), '2h 15m', 'the median barely moves: 1h 30m to 2h 15m');
assert.equal(D.formatJobDuration(withOutlier.averageMs), '4h 53m', 'the average nearly triples on one stale job, which is why it is not the headline');

const empty = D.summarize([job({ job_started_at: null })]);
assert.equal(empty.count, 0);
assert.equal(empty.averageMs, null, 'no measurable job means no number, not zero');
assert.equal(empty.medianMs, null);
assert.equal(D.summarize([]).missing, 0);

// Even count averages the middle pair.
assert.equal(D.summarize([job({ completed_at: at(60) }), job({ completed_at: at(120) })]).medianMs, 90 * 60000);

// ── 6. By service ───────────────────────────────────────────────────────────
const services = D.byService([
  job({ service: 'Mounting & Hanging', completed_at: at(30) }),
  job({ service: 'Furniture Assembly', completed_at: at(120) }),
  job({ service: 'Furniture Assembly', completed_at: at(180) }),
  job({ service: null, completed_at: at(45) }),
  job({ service: 'Smart Home', job_started_at: null }),
]);
assert.deepEqual(services.map(r => r.service), ['Furniture Assembly', 'Other', 'Mounting & Hanging'],
  'longest typical job first; a blank service falls back to Other');
assert.equal(services[0].count, 2);
assert.equal(D.formatJobDuration(services[0].medianMs), '2h 30m');
assert.ok(!services.some(r => r.service === 'Smart Home'),
  'a service with nothing measurable is left out of the ranking rather than charted as zero');

// ── 7. The server has to carry the stamp ────────────────────────────────────
// job_started_at was already SELECTed in the finance ledger and simply never
// put on the row. Without both of these the Insights panel silently renders
// every job as unmeasured.
const ledger = await read('api/owner/_finance-ledger.js');
assert.match(ledger, /\.select\('[^']*job_started_at/, 'the ledger query must still select job_started_at');
assert.match(ledger, /jobStartedAt: b\.job_started_at/, 'the ledger row must carry the start stamp');
const dashboard = await read('api/owner/financial-dashboard.js');
assert.match(dashboard, /jobStartedAt: row\.jobStartedAt/, 'the dashboard must pass the start stamp through to the browser');

// ── 8. The dashboard has to render it ───────────────────────────────────────
const owner = await read('owner/index.html');
assert.ok(owner.includes('/assets/js/job-duration.js'), 'the owner dashboard must load the shared module');
assert.match(owner, /[\r\n]\s*jobDurationField\(b\),/,
  'the drawer field list must CALL jobDurationField, because matching the bare name also matches its own definition');
assert.ok(owner.includes("getElementById('an-job-duration')"), 'the Insights panel must be filled');
assert.ok(owner.includes('id="an-job-duration"'), 'the Insights panel must exist in the markup');

// A panel that is not classified renders under Money, where an operational
// metric does not belong, and disappears from Insights entirely.
const insightsRule = owner.match(/if \(has\('([^']*)'\)\) return 'insights';/);
assert.ok(insightsRule && insightsRule[1].includes('#an-job-duration'),
  'the panel must be registered under the Insights sub-tab');
const mixedRule = owner.match(/var MIXED = '([^']*)';/);
assert.ok(mixedRule && mixedRule[1].includes('#an-job-duration'),
  'the panel shares the breakdown grid, so it must be listed in MIXED or the whole grid toggles as one');

// Nothing may recompute the span inline. One helper, or the drawer and the
// panel eventually disagree about the same job.
const inlineMath = owner.match(/completed_at\s*\)?\s*-\s*.*job_started_at|job_started_at\s*\)?\s*-/);
assert.equal(inlineMath, null, 'duration math belongs in assets/js/job-duration.js, not inline in the dashboard');

// ── A job left open is not a long job ───────────────────────────────────────
// AAE-DVSNHXE4OO was worked Sep 24 and closed Sep 26 once a payment problem
// was resolved. It recorded 50h 24m, was the only timed Outdoor & Playsets
// job, and so became the median — the dashboard reported that a playset
// typically takes fifty hours.
const HOUR = 3600000;
const span = h => ({ service: 'Outdoor & Playsets', job_started_at: '2026-09-24T14:12:59Z',
  completed_at: new Date(Date.parse('2026-09-24T14:12:59Z') + h * HOUR).toISOString() });

const incident = D.summarize([span(50.4)]);
assert.equal(incident.count, 0, 'a job left open for two days must not be counted as work');
assert.equal(incident.unverified, 1, 'and must be reported, not silently dropped');
assert.equal(incident.medianMs, null, 'with nothing trustworthy left there is no typical time');

// A genuinely long build still counts. The longest real job on record is nine
// hours, so the ceiling must not throw that away.
const real = D.summarize([span(9)]);
assert.equal(real.count, 1, 'a nine-hour build is real work');
assert.equal(real.unverified, 0);
assert.ok(D.MAX_TRUSTWORTHY_JOB_MS > 9 * HOUR, 'the ceiling must clear the longest genuine job');
assert.ok(D.MAX_TRUSTWORTHY_JOB_MS <= 24 * HOUR, 'but a span over a day is never one sitting of work');

// One stale job must not drag the median of the good ones.
const staleMix = D.summarize([span(2), span(3), span(4), span(50.4)]);
assert.equal(staleMix.count, 3);
assert.equal(staleMix.unverified, 1);
assert.equal(staleMix.medianMs, 3 * HOUR, 'the median is of the trustworthy jobs only');

// missing and unverified are different facts and must stay separate: one is
// "we never had the data", the other is "we had it and it was not work".
const both = D.summarize([{ service: 'X', completed_at: '2026-09-24T14:00:00Z' }, span(50.4)]);
assert.equal(both.missing, 1);
assert.equal(both.unverified, 1);

// The dashboard has to say so. A silently shrinking sample is the same lie in
// a quieter voice.
assert.match(owner, /durAll\.unverified/, 'the panel must surface the excluded count');
assert.match(owner, /left open more than 16 hours/, 'and say why those jobs were excluded');

console.log('PASS job duration: math, honest gaps, jobs left open excluded and reported, server passthrough, dashboard wiring');
