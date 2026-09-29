import assert from 'node:assert/strict';
import { BOOKING_STATUS, TERMINAL_BOOKING_STATUSES } from '../api/_source-of-truth.js';
import { BOOKING_WORKFLOW_TRANSITIONS } from '../api/booking/_workflow-engine.js';

const reachable = new Set([BOOKING_STATUS.PENDING]);
const queue = [BOOKING_STATUS.PENDING];
while (queue.length) {
  const current = queue.shift();
  for (const next of BOOKING_WORKFLOW_TRANSITIONS[current] || []) {
    if (!reachable.has(next)) {
      reachable.add(next);
      queue.push(next);
    }
  }
}

const expectedReachable = new Set([
  BOOKING_STATUS.PENDING,
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.EN_ROUTE,
  BOOKING_STATUS.ARRIVED,
  BOOKING_STATUS.IN_PROGRESS,
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.DECLINED,
]);
assert.deepEqual([...reachable].sort(), [...expectedReachable].sort());
assert.equal(reachable.has(BOOKING_STATUS.REFUNDED), false);
for (const terminal of TERMINAL_BOOKING_STATUSES) {
  assert.equal((BOOKING_WORKFLOW_TRANSITIONS[terminal] || []).length, 0);
}

console.log('booking state reachability: PASS');
