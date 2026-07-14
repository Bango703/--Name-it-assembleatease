import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GUEST_ACCESS_TOKEN_SECRET = 'review-test-secret-that-is-longer-than-thirty-two-characters';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const compact = source => source.replace(/\s+/g, ' ');

const {
  issueReviewToken,
  verifyReviewToken,
  REVIEW_TOKEN_TTL_MS,
} = await import('../api/_review-token.js');
const {
  finalizeCompletionRewards,
  markCompletionRewardReconciliation,
} = await import('../api/booking/_completion-rewards.js');

const now = Date.UTC(2026, 6, 14, 12, 0, 0);
const reviewIdentity = {
  bookingId: '11111111-1111-4111-8111-111111111111',
  ref: 'AAE-SECURE1',
  email: 'customer@example.com',
};
const reviewToken = issueReviewToken({ ...reviewIdentity, nowMs: now });
assert.equal(verifyReviewToken(reviewToken, { ...reviewIdentity, nowMs: now + 1000 }), true);
assert.equal(verifyReviewToken(reviewToken, { ...reviewIdentity, bookingId: 'other', nowMs: now + 1000 }), false);
assert.equal(verifyReviewToken(reviewToken, { ...reviewIdentity, ref: 'AAE-OTHER', nowMs: now + 1000 }), false);
assert.equal(verifyReviewToken(reviewToken, { ...reviewIdentity, email: 'easer@example.com', nowMs: now + 1000 }), false);
assert.equal(verifyReviewToken(reviewToken, { ...reviewIdentity, nowMs: now + REVIEW_TOKEN_TTL_MS + 1 }), false);
assert.equal(verifyReviewToken(`${reviewToken.slice(0, -1)}x`, { ...reviewIdentity, nowMs: now + 1000 }), false);
assert.throws(
  () => issueReviewToken({ ...reviewIdentity, nowMs: now, ttlMs: REVIEW_TOKEN_TTL_MS + 1 }),
  /lifetime is invalid/,
);

function mockSupabase({ ledgerError = null, releaseResult = true } = {}) {
  const calls = [];
  const ledgerRow = {
    booking_id: 'booking-1',
    booking_ref: 'AAE-REWARD1',
    customer_email: 'customer@example.com',
    amount_earned_cents: 500,
    status: 'available',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  return {
    calls,
    from(table) {
      if (table === 'assemblecash_ledger') {
        return {
          async insert(payload) {
            calls.push(['ledger-insert', payload]);
            return { error: null };
          },
          select() {
            const chain = {
              eq() { return chain; },
              gt() { return chain; },
              async maybeSingle() {
                calls.push(['ledger-verify']);
                return { data: ledgerError ? null : ledgerRow, error: ledgerError };
              },
            };
            return chain;
          },
        };
      }
      if (table === 'bookings') {
        return {
          update(payload) {
            calls.push(['booking-update', payload]);
            const chain = {
              eq() { return chain; },
              in() { return chain; },
              async select() { return { data: [{ id: 'booking-1' }], error: null }; },
            };
            return chain;
          },
          select() {
            const chain = {
              eq() { return chain; },
              async maybeSingle() {
                return {
                  data: {
                    status: 'completed',
                    payment_status: 'captured',
                    assemblecash_earned_cents: 500,
                    financial_operation_key: null,
                  },
                  error: null,
                };
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      return { data: releaseResult, error: null };
    },
  };
}

const completionBooking = {
  id: 'booking-1',
  ref: 'AAE-REWARD1',
  customer_email: 'customer@example.com',
  status: 'completed',
  payment_status: 'captured',
  amount_charged: 10000,
};
const successDb = mockSupabase();
const success = await finalizeCompletionRewards(successDb, {
  booking: completionBooking,
  operationKey: 'complete:booking-1',
  amountChargedCents: 10000,
});
assert.equal(success.ok, true);
assert.equal(success.earnedCents, 500);
const bookingSyncIndex = successDb.calls.findIndex(([name]) => name === 'booking-update');
const releaseIndex = successDb.calls.findIndex(([name]) => name === 'rpc');
assert.ok(bookingSyncIndex >= 0 && releaseIndex > bookingSyncIndex, 'reward must persist before exact lock release');
assert.deepEqual(successDb.calls[bookingSyncIndex][1], {
  financial_reconciliation_required_at: null,
  financial_reconciliation_reason: null,
  assemblecash_earned_cents: 500,
});

const ambiguousDb = mockSupabase({ ledgerError: { code: '08006', message: 'connection lost' } });
const ambiguous = await finalizeCompletionRewards(ambiguousDb, {
  booking: completionBooking,
  operationKey: 'complete:booking-1',
  amountChargedCents: 10000,
});
assert.equal(ambiguous.ok, false);
assert.equal(ambiguous.code, 'COMPLETION_REWARD_VERIFICATION_FAILED');
assert.equal(ambiguousDb.calls.some(([name]) => name === 'rpc'), false, 'ambiguous reward must retain lock');
assert.equal(await markCompletionRewardReconciliation(ambiguousDb, {
  bookingId: completionBooking.id,
  operationKey: 'complete:booking-1',
  reason: ambiguous.code,
}), true);
const markerPayload = ambiguousDb.calls.filter(([name]) => name === 'booking-update').at(-1)[1];
assert.match(markerPayload.financial_reconciliation_reason, /COMPLETION_REWARD_VERIFICATION_FAILED/);

const reviewApi = read('api/review.js');
const manualReviewRequest = read('api/review-request.js');
const cronReviewRequest = read('api/cron/review-request.js');
const reviewPage = read('review.html');
assert.match(reviewApi, /verifyReviewToken\(token/);
assert.match(reviewApi, /if \(!token\)/);
assert.doesNotMatch(reviewApi, /detail:\s*error\.message/);
assert.match(manualReviewRequest, /issueReviewToken/);
assert.match(manualReviewRequest, /token=\$\{encodeURIComponent\(reviewToken\)\}/);
assert.match(cronReviewRequest, /issueReviewToken/);
assert.match(cronReviewRequest, /token=\$\{encodeURIComponent\(reviewToken\)\}/);
assert.match(reviewPage, /token:\s*reviewToken/);
assert.match(reviewPage, /if \(ref && email && reviewToken\)/);
assert.match(reviewPage, /<meta name="referrer" content="no-referrer"/);
assert.match(reviewPage, /history\.replaceState\(\{\}, document\.title, window\.location\.pathname\)/);

for (const file of ['api/booking/complete.js', 'api/booking/assembler-complete.js']) {
  const source = read(file);
  assert.doesNotMatch(source, /financial_operation_key:\s*null/);
  assert.match(source, /finalizeCompletionRewards/);
  assert.match(source, /surfaceCompletionRewardHold/);
  assert.match(source, /reconciliationRequired/);
}

const completionHelper = compact(read('api/booking/_completion-rewards.js'));
assert.ok(
  completionHelper.indexOf('.update(bookingRewardUpdate)')
    < completionHelper.indexOf('const released = await releaseBookingFinancialOperation'),
  'booking reward sync must precede financial lock release',
);
assert.match(completionHelper, /financial_reconciliation_required_at/);

const acceptDispatch = read('api/booking/accept-dispatch.js');
const declineDispatch = read('api/booking/decline-dispatch.js');
const dropJob = read('api/booking/drop-job.js');
assert.ok((acceptDispatch.match(/role !== 'assembler'/g) || []).length >= 3);
assert.match(declineDispatch, /easerProfile\.role !== 'assembler'/);
assert.match(dropJob, /easerProfile\.role !== 'assembler'/);
assert.doesNotMatch(declineDispatch, /requireActiveApprovedEaser/);
assert.doesNotMatch(dropJob, /requireActiveApprovedEaser/);

console.log('PASS: completion reward lock, secure review token, and Easer role guard checks');
