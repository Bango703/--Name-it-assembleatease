import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateEaserAppointmentGate } from '../api/booking/_appointment-gates.js';

const jobsPage = await readFile(new URL('../assembler/my-assignments.html', import.meta.url), 'utf8');
const homePage = await readFile(new URL('../assembler/index.html', import.meta.url), 'utf8');
const earningsPage = await readFile(new URL('../assembler/payouts.html', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../assets/js/app.js', import.meta.url), 'utf8');
const assignmentsApi = await readFile(new URL('../api/booking/my-assignments.js', import.meta.url), 'utf8');
const appointmentGates = await readFile(new URL('../api/booking/_appointment-gates.js', import.meta.url), 'utf8');
const messageApi = await readFile(new URL('../api/booking/message.js', import.meta.url), 'utf8');
const dropApi = await readFile(new URL('../api/booking/drop-job.js', import.meta.url), 'utf8');

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
assert.doesNotMatch(jobsPage, /const workloadLine =|workloadLine \?/,
  'The detail header must not duplicate the item list rendered below it.');
assert.match(appJs, /formatServiceLabel\(service\)[\s\S]*Trampoline Move & Reassembly/,
  'Internal service labels must have one shared Easer-facing translator.');
for (const surface of [homePage, jobsPage, earningsPage]) {
  assert.match(surface, /APP\.formatServiceLabel/,
    'Every core Easer surface must use the shared service-label translator.');
}

assert.match(jobsPage, /function formatJobAddress\(rawAddress\)/,
  'Jobs need a readable local address formatter.');
assert.doesNotMatch(jobsPage, /APP\.formatAddress\(b\.address\)/,
  'Job cards and details must not force accepted-job addresses to all caps.');
assert.match(homePage, /APP\.formatPostalAddress/,
  'Home must use the same readable postal address casing as Jobs.');
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
assert.match(jobsPage, /accepted \? 'Your payout' : 'Estimated payout'/,
  'Accepted jobs must label the current amount as the Easer payout.');
assert.match(jobsPage, /const payoutPill = !isCompleted && payEst/,
  'Completed details must not repeat the payout status above the authoritative payout card.');
assert.match(earningsPage, /Includes all recorded earnings, whether paid, awaiting payout, or on hold\./,
  'Total Earned must explain that it includes every payout disposition.');

assert.match(jobsPage, /Booking reference:/,
  'The detail sheet must spell out the booking reference label.');
assert.match(jobsPage, /class="booking-ref-copy"/,
  'The booking reference must be easy to copy for support.');
assert.doesNotMatch(jobsPage, />Ref: /,
  'The abbreviated booking reference label must not return.');
assert.match(jobsPage, /id="asgn-modal" role="dialog" aria-modal="true"[\s\S]*aria-hidden="true"/,
  'Job details must expose correct dialog semantics.');
assert.match(jobsPage, /function openAssignmentModal\(\)[\s\S]*asgn-modal-close[\s\S]*\.focus\(\)/,
  'Opening job details must move keyboard focus into the dialog.');
assert.doesNotMatch(jobsPage, /\bconfirm\(/,
  'Jobs must use an in-app confirmation instead of a native browser prompt.');
assert.match(jobsPage, /id="release-confirmation"[\s\S]*id="release-confirm-submit"/,
  'Self-drop must require an explicit in-app confirmation.');
assert.doesNotMatch(homePage, /window\.confirm|\balert\(/,
  'Home must not interrupt job work with native browser dialogs.');
assert.match(homePage, /id="home-decline-sheet" role="dialog"/,
  'Declining a Home offer must use an accessible in-app confirmation.');
assert.match(homePage, /id="home-complete-status" role="alert"/,
  'Completion errors must remain visible inside the completion sheet.');
assert.match(homePage, /<a class="eh-upcoming-card" href="\/assembler\/my-assignments"/,
  'Upcoming jobs must be native keyboard-accessible links.');

assert.match(assignmentsApi, /evaluateEaserAppointmentGate/,
  'The assignments API must reuse the server appointment gate.');
assert.match(assignmentsApi, /booking\._stage_availability = Object\.fromEntries/,
  'The read-only assignment payload must expose server-calculated stage availability.');
assert.match(jobsPage, /stageAvailabilityDisplay\(b\._stage_availability && b\._stage_availability\[s\.stage\]/,
  'The detail sheet must apply the server-calculated stage gate before a tap.');
assert.match(jobsPage, /setStageButtonReady\(!availability\.disabled\)/,
  'Unavailable stage actions must render disabled.');
assert.match(jobsPage, /setStageMessage\(stageMessage, 'Not available yet'/,
  'Early-stage guidance must render inside the active job sheet.');
assert.match(jobsPage, /d\.code === 'APPOINTMENT_STAGE_TOO_EARLY'/,
  'A server rejection must remain inside the job sheet even when browser state is stale.');
assert.doesNotMatch(appointmentGates, /Contact the owner before updating this job/,
  'Easer-facing appointment errors must not expose the internal owner role.');

assert.equal(
  (jobsPage.match(/Need help with this job\?/g) || []).length,
  1,
  'The job sheet must expose one quiet support entry point.',
);
assert.doesNotMatch(jobsPage, /id="drop-section"|id="drop-toggle"|Need to drop this job\?/,
  'The duplicate drop card and escape link must not return.');
assert.match(jobsPage, /id="support-body" style="display:none"/,
  'Support must stay subordinate to the normal job workflow.');
for (const supportType of ['job_issue', 'cannot_make', 'customer_unavailable', 'safety_concern', 'other']) {
  assert.match(jobsPage, new RegExp(`data-support-type="${supportType}"`));
}
assert.match(jobsPage, /function renderSupportWorkflow\(type\)/);
assert.match(jobsPage, /postSupportMessage\(body, _selectedSupportType \|\| null\)/,
  'Follow-up messages must not create duplicate Operations Cases.');
assert.match(jobsPage, /The booking, appointment, current job status, and request time will be attached automatically/);
assert.match(jobsPage, /Your assignment remains active until support confirms a change/,
  'A release request must not imply that the booking was already mutated.');
assert.match(jobsPage, /If anyone is in immediate danger, call 911/);
assert.match(jobsPage, />Send Urgent Report</);
assert.match(jobsPage, /canSelfDrop[\s\S]*minsSinceAcceptance <= 15/,
  'The existing 15-minute self-drop remains available only inside the routed exception flow.');

assert.match(messageApi, /const EASER_SUPPORT_TYPES = Object\.freeze/);
assert.match(messageApi, /safety_concern:[\s\S]*OPERATION_CASE_TYPES\.SAFETY[\s\S]*OPERATION_CASE_SEVERITIES\.CRITICAL/);
assert.match(messageApi, /supportType && resolvedSender !== 'assembler'/,
  'Only the assigned Easer path may create structured Easer support cases.');
assert.match(messageApi, /createOperationCase\(sb,[\s\S]*sourceRef: `easer-support-message:\$\{message\.id\}`/);
assert.match(messageApi, /operationCaseId: operationCase\?\.id \|\| null/,
  'Owner notification attempts must link back to the operations case when available.');
assert.match(dropApi, /const DROP_REASONS = new Set/);
assert.match(dropApi, /reason: reason \|\| null,[\s\S]*note: note \|\| null/,
  'A valid self-drop reason must remain in the booking audit trail.');

const earlyGate = evaluateEaserAppointmentGate({
  date: '2026-08-20',
  time: '10:00 AM - 12:00 PM',
  stage: 'en_route',
  nowMs: 0,
});
const earliestEnRouteMs = Date.parse(earlyGate.earliestAt);
assert.equal(earlyGate.earlyWindowMinutes, 120, 'On My Way must retain the two-hour window.');
assert.equal(evaluateEaserAppointmentGate({
  date: '2026-08-20', time: '10:00 AM - 12:00 PM', stage: 'en_route', nowMs: earliestEnRouteMs - 1,
}).allowed, false, 'On My Way must remain blocked immediately before the two-hour boundary.');
assert.equal(evaluateEaserAppointmentGate({
  date: '2026-08-20', time: '10:00 AM - 12:00 PM', stage: 'en_route', nowMs: earliestEnRouteMs,
}).allowed, true, 'On My Way must open exactly two hours before the appointment.');

console.log('Easer Jobs queue checks passed');
