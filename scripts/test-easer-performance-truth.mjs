import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deriveManualPayoutReadiness } from '../api/owner/_finance-ledger.js';

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const [
  migration,
  completionApi,
  earningsApi,
  earningsMapper,
  assignmentsApi,
  payoutApi,
  homeUi,
  jobsUi,
  profileUi,
] = await Promise.all([
  read('api/migrations/048_easer_performance_truth.sql'),
  read('api/booking/assembler-complete.js'),
  read('api/assembler/earnings.js'),
  read('api/assembler/_earnings.js'),
  read('api/booking/my-assignments.js'),
  read('api/booking/payout.js'),
  read('assembler/index.html'),
  read('assembler/my-assignments.html'),
  read('assembler/profile.html'),
]);

assert.equal((migration.match(/^BEGIN;$/gm) || []).length, 1);
assert.equal((migration.match(/^COMMIT;$/gm) || []).length, 1);
assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
assert.match(migration, /set_config\('request\.jwt\.claim\.role', 'service_role', true\)/);
assert.match(migration, /set_config\('request\.jwt\.claims', '\{"role":"service_role"\}', true\)/);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.sync_easer_performance_counters/);
assert.match(migration, /COALESCE\(booking\.return_visit_required, FALSE\) IS FALSE/);
assert.match(migration, /CREATE TRIGGER bookings_refresh_easer_performance/);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.increment_profile_counters/);
assert.match(migration, /VALUES \(48, 'easer_performance_truth'\)/);
assert.doesNotMatch(completionApi, /sb\.rpc\('increment_profile_counters'/);

const readiness = deriveManualPayoutReadiness({
  status: 'completed',
  return_visit_required: true,
  assembler_id: 'easer-1',
  payout_status: 'pending',
  payout_mode_snapshot: 'manual',
  payment_status: 'captured',
}, { owed: 24550 });
assert.equal(readiness.disposition, 'on_hold');
assert.ok(readiness.holdCodes.includes('return_visit_open'));

assert.match(earningsMapper, /return_visit_open/);
assert.match(earningsMapper, /label: 'Action Required'/);
assert.match(earningsMapper, /Complete the remaining work before this amount becomes payable/);
assert.match(earningsApi, /row\.returnVisitRequired === true/);
assert.match(payoutApi, /code: 'RETURN_VISIT_OPEN'/);

assert.match(assignmentsApi, /booking\._return_visit_open/);
assert.match(assignmentsApi, /ACTIVE_BOOKING_STATUSES\.includes\(booking\.status\) \|\| hasOpenReturnVisit/);
assert.match(jobsUi, /function isFullyCompleted\(b\)/);
assert.match(jobsUi, /label: 'Return Visit Open'/);
assert.match(homeUi, /fetch\('\/api\/assembler\/earnings'/);
assert.match(homeUi, /loadCanonicalPerformance\(freshTok\)/);
assert.doesNotMatch(homeUi, /var earnedCents=profile\.total_earned/);
assert.match(profileUi, /fetch\('\/api\/assembler\/earnings'/);
assert.doesNotMatch(profileUi, /formatCents\(profile\.total_earned\)/);

console.log('Easer performance and open-return truth tests: PASS');
