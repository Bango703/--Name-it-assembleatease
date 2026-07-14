import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcileBookingCredits } from '../api/_assemblecash.js';

const CANCELLATION_REWARDS_RECONCILIATION_REASON = 'AssembleCash cancellation reconciliation did not complete. Do not retry payment, refund, or payout actions until reviewed.';
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  assembleCash,
  refundEndpoint,
  refundCredits,
  cancellationCredits,
  ownerCancellation,
  customerCancellation,
  guestCancellation,
  webhook,
  ownerUi,
  ownerLiveOps,
  payoutReview,
  migration037,
] = await Promise.all([
  load('api/_assemblecash.js'),
  load('api/booking/refund.js'),
  load('api/booking/_refund-credits.js'),
  load('api/booking/_cancellation-credits.js'),
  load('api/booking/cancel.js'),
  load('api/booking/customer-cancel.js'),
  load('api/booking/guest-cancel.js'),
  load('api/assembler/stripe-webhook.js'),
  load('owner/index.html'),
  load('api/owner/live-ops.js'),
  load('api/booking/payout-review.js'),
  load('api/migrations/037_owner_easer_workflow_completion.sql'),
]);

function between(source, start, end = null) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = end == null ? source.length : source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function sqlFunction(source, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startPattern = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${escapedName}\\s*\\(`,
    'i',
  );
  const startMatch = startPattern.exec(source);
  assert.ok(startMatch, `migration 037 does not define ${functionName}`);

  const remainder = source.slice(startMatch.index);
  const bodyMarker = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(remainder);
  assert.ok(bodyMarker, `${functionName} is missing a dollar-quoted body`);
  const bodyStart = bodyMarker.index + bodyMarker[0].length;
  const bodyEnd = remainder.indexOf(bodyMarker[1], bodyStart);
  assert.notEqual(bodyEnd, -1, `${functionName} has no closing body delimiter`);
  return remainder.slice(0, bodyEnd + bodyMarker[1].length);
}

function aggregateFilter(functionSql, amountColumn) {
  const escapedColumn = amountColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `SUM\\s*\\(\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\.)?${escapedColumn}\\s*\\)\\s*FILTER\\s*\\(`,
    'i',
  );
  const match = pattern.exec(functionSql);
  assert.ok(match, `${amountColumn} aggregate FILTER is missing`);

  const openIndex = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = openIndex; index < functionSql.length; index += 1) {
    if (functionSql[index] === '(') depth += 1;
    if (functionSql[index] === ')') {
      depth -= 1;
      if (depth === 0) return functionSql.slice(openIndex + 1, index);
    }
  }
  assert.fail(`${amountColumn} aggregate FILTER is not balanced`);
}

function assertRewardSourceExclusions(functionSql, label) {
  const earnedFilter = aggregateFilter(functionSql, 'amount_earned_cents');
  const redeemedFilter = aggregateFilter(functionSql, 'amount_redeemed_cents');

  assert.match(earnedFilter, /status\s*=\s*'available'/i, `${label} must count only available earn rows`);
  assert.match(earnedFilter, /booking/i, `${label} must inspect the reward-source booking`);
  assert.match(earnedFilter, /source_booking\.status\s*=\s*'completed'/i,
    `${label} must require a completed reward-source booking`);
  assert.match(earnedFilter, /source_booking\.payment_status\s*=\s*'captured'/i,
    `${label} must require captured payment truth`);
  assert.match(earnedFilter, /source_booking\.financial_operation_key\s+IS\s+NULL/i,
    `${label} must exclude a reward source with an active financial operation`);
  assert.match(earnedFilter, /source_booking\.financial_reconciliation_required_at\s+IS\s+NULL/i,
    `${label} must exclude a reward source with an unresolved hold`);
  assert.match(earnedFilter, /source_booking\.assemblecash_earned_cents\s*=\s*ledger\.amount_earned_cents/i,
    `${label} must match booking summary to ledger truth`);

  assert.match(redeemedFilter, /status\s*=\s*'redeemed'/i, `${label} must still subtract redeemed debit rows`);
  assert.doesNotMatch(
    redeemedFilter,
    /booking|refund|cancel|financial_operation|amount_earned/i,
    `${label} must not apply reward-source booking exclusions to redeemed debit rows`,
  );
}

function assertServiceRoleOnly(functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const revokePattern = new RegExp(
    `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${escapedName}\\s*\\([^;]*\\)\\s+FROM\\s+([^;]+);`,
    'ig',
  );
  const revokes = [...migration037.matchAll(revokePattern)].map(match => match[1].toLowerCase());
  assert.ok(revokes.length, `migration 037 does not revoke default execution on ${functionName}`);
  const revokedRoles = revokes.join(',');
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(revokedRoles, new RegExp(`\\b${role}\\b`), `${functionName} execution is not revoked from ${role}`);
  }

  const grantPattern = new RegExp(
    `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${escapedName}\\s*\\([^;]*\\)\\s+TO\\s+([^;]+);`,
    'ig',
  );
  const grants = [...migration037.matchAll(grantPattern)].map(match => match[1].trim().toLowerCase());
  assert.ok(grants.length, `migration 037 does not grant ${functionName} to service_role`);
  assert.ok(grants.some(roles => /\bservice_role\b/.test(roles)), `${functionName} is not executable by service_role`);
  assert.ok(
    grants.every(roles => !/\b(?:public|anon|authenticated)\b/.test(roles)),
    `${functionName} must not be granted to browser-facing roles`,
  );
}

function extractJsFunction(source, functionName, endMarker) {
  return between(source, `function ${functionName}(`, endMarker);
}

function countButtons(html) {
  return (String(html).match(/<button\b/gi) || []).length;
}

await check('reconcileBookingCredits uses only the serialized database RPC', () => {
  const reconcileSource = between(
    assembleCash,
    'export async function reconcileBookingCredits',
    'export function maxRedeemableCents',
  );
  assert.match(reconcileSource, /sb\.rpc\('assemblecash_reconcile_booking_credits',\s*\{/);
  assert.match(reconcileSource, /p_booking_id:\s*bookingId/);
  assert.match(reconcileSource, /p_release_redemption:\s*!!releaseRedemption/);
  assert.match(reconcileSource, /p_reason:\s*reason\s*\|\|\s*'reverse:booking_financial_reversal'/);
  assert.doesNotMatch(
    reconcileSource,
    /\.from\(['"]assemblecash_ledger['"]\)/,
    'reconciliation must not fall back to non-serialized direct ledger writes',
  );
});

await check('reconcileBookingCredits maps a successful mocked RPC response', async () => {
  const calls = [];
  const sb = {
    rpc: async (name, params) => {
      calls.push({ name, params });
      return {
        data: [{
          reversed_earn_count: '2',
          released_redemption_count: '1',
          earned_reconciled: true,
          redemption_reconciled: true,
        }],
        error: null,
      };
    },
  };

  const result = await reconcileBookingCredits(sb, {
    bookingId: 'booking-reward-success',
    releaseRedemption: true,
    reason: 'reverse:test',
  });

  assert.deepEqual(calls, [{
    name: 'assemblecash_reconcile_booking_credits',
    params: {
      p_booking_id: 'booking-reward-success',
      p_release_redemption: true,
      p_reason: 'reverse:test',
    },
  }]);
  assert.deepEqual(result, {
    ok: true,
    reversedEarnCount: 2,
    releasedRedemptionCount: 1,
    earnedReconciled: true,
    redemptionReconciled: true,
  });
});

await check('reconcileBookingCredits fails closed when durable ledger truth mismatches the booking', async () => {
  const result = await reconcileBookingCredits({
    rpc: async () => ({
      data: [{
        reversed_earn_count: '0',
        released_redemption_count: '0',
        earned_reconciled: false,
        redemption_reconciled: true,
      }],
      error: null,
    }),
  }, {
    bookingId: 'booking-reward-mismatch',
    releaseRedemption: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.unavailable, false);
  assert.equal(result.earnedReconciled, false);
  assert.equal(result.redemptionReconciled, true);
  assert.match(result.error, /durable ledger truth does not match/i);
});

await check('reconcileBookingCredits fails closed on a mocked RPC error', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await reconcileBookingCredits({
      rpc: async () => ({ data: null, error: { code: 'XX000', message: 'database reconciliation failed' } }),
    }, {
      bookingId: 'booking-reward-failure',
      releaseRedemption: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.unavailable, false);
    assert.match(result.error, /database reconciliation failed/);
  } finally {
    console.warn = originalWarn;
  }
});

await check('refund state keeps its exact owner lock through serialized rewards reconciliation', () => {
  assert.match(refundCredits, /reconcileBookingCredits\(sb,\s*\{/);
  const mainRefund = between(
    refundEndpoint,
    '// Update cumulative booking refund truth.',
    '// #7 — Send customer refund email',
  );
  const persistedIndex = mainRefund.indexOf(".eq('financial_operation_type', 'refund_owner')");
  const rewardsIndex = mainRefund.indexOf('rewardsReversal = await reconcileRefundAssembleCash', persistedIndex);
  const releaseIndex = mainRefund.indexOf('finalizeRefundReconciliation', rewardsIndex);
  assert.ok(persistedIndex >= 0 && rewardsIndex > persistedIndex && releaseIndex > rewardsIndex,
    'refund persistence, serialized rewards reconciliation, and lock release are out of order');

  const persistedPayload = between(mainRefund, "sb.from('bookings').update({", "}).eq('id', booking.id)");
  assert.doesNotMatch(persistedPayload, /financial_operation_(?:key|type|started_at)\s*:/,
    'refund state persistence must not clear its reservation');

  const finalizer = between(refundEndpoint, 'async function finalizeRefundReconciliation', 'function ownerRefundOperationTarget');
  assert.match(finalizer, /financial_operation_key:\s*null/);
  assert.match(finalizer, /\.eq\('id', bookingId\)/);
  assert.match(finalizer, /\.eq\('financial_operation_key', operationKey\)/);
  assert.match(finalizer, /\.eq\('financial_operation_type', 'refund_owner'\)/);
});

await check('all cancellation paths retain the exact lock until serialized rewards reconciliation', () => {
  const routes = [
    ['owner cancellation', ownerCancellation, "operationType"],
    ['customer cancellation', customerCancellation, "'cancel_customer'"],
    ['guest cancellation', guestCancellation, "'cancel_guest'"],
  ];
  for (const [label, source, operationTypeExpression] of routes) {
    const cancellationState = between(source, 'const cancellationUpdate = {', 'const cancellationCredits = await reconcileCancellationAssembleCash');
    assert.doesNotMatch(
      cancellationState.slice(0, cancellationState.indexOf('let updateQuery')),
      /financial_operation_(?:key|type|started_at)\s*:/,
      `${label} must not clear its reservation in the cancellation payload`,
    );
    assert.match(cancellationState, /\.eq\('financial_operation_key', operationKey\)/, `${label} lacks exact lock-key CAS`);
    assert.match(
      cancellationState,
      new RegExp(`\\.eq\\('financial_operation_type', ${operationTypeExpression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
      `${label} lacks exact lock-type CAS`,
    );
  }

  const successRelease = between(
    cancellationCredits,
    'if (reconciled?.ok)',
    "const { error: holdError }",
  );
  assert.match(successRelease, /financial_operation_key:\s*null/);
  assert.match(successRelease, /\.eq\('id', booking\.id\)/);
  assert.match(successRelease, /\.eq\('financial_operation_key', operationKey\)/);
  assert.match(successRelease, /\.in\('financial_operation_type', \['cancel_owner', 'cancel_customer', 'cancel_guest'\]\)/);

  const failureHold = between(cancellationCredits, "const { error: holdError }", "const idempotencyKey");
  assert.match(failureHold, /financial_reconciliation_reason:\s*CANCELLATION_REWARDS_RECONCILIATION_REASON/);
  assert.match(failureHold, /\.eq\('financial_operation_key', operationKey\)/);
  assert.match(failureHold, /\.in\('financial_operation_type', \['cancel_owner', 'cancel_customer', 'cancel_guest'\]\)/);
});

await check('charge.refunded never clears a matching refund lock before rewards and audit durability', () => {
  const chargeRefunded = between(webhook, "case 'charge.refunded':", "case 'charge.dispute.created':");
  const refundUpdate = between(chargeRefunded, 'const refundUpdate = {', 'let refundUpdateQuery');
  assert.doesNotMatch(refundUpdate, /financial_operation_(?:key|type|started_at)\s*:\s*null/,
    'webhook refund truth persistence must preserve the existing lock tuple');
  assert.match(chargeRefunded, /refundUpdateQuery\.eq\('financial_operation_key', booking\.financial_operation_key\)/);
  assert.match(chargeRefunded, /refundUpdateQuery\.eq\('financial_operation_type', booking\.financial_operation_type\)/);
  assert.match(chargeRefunded, /refundUpdateQuery\.eq\('financial_operation_started_at', booking\.financial_operation_started_at\)/);

  const rewardsIndex = chargeRefunded.indexOf('const rewardsReversal = await reconcileRefundAssembleCash');
  const auditIndex = chargeRefunded.indexOf('const refundAudit = await writeFinancialAudit', rewardsIndex);
  const clearGateIndex = chargeRefunded.indexOf('if (clearRefundLock)', auditIndex);
  const firstLockClearIndex = chargeRefunded.indexOf('financial_operation_key: null');
  assert.ok(rewardsIndex >= 0 && auditIndex > rewardsIndex && clearGateIndex > auditIndex,
    'webhook rewards, financial audit, and exact lock-release gate are out of order');
  assert.ok(firstLockClearIndex > auditIndex,
    'webhook clears the refund lock before reward and audit work is durable');
  assert.match(chargeRefunded, /\.eq\('financial_operation_key', expectedRefundOperationKey\)/);
  assert.match(chargeRefunded, /\.eq\('financial_operation_type', 'refund_owner'\)/);
  const rewardFailure = between(chargeRefunded, 'if (!rewardsReversal.ok)', 'if (clearRefundLock)');
  assert.match(rewardFailure, /financial_operation_key\s*=\s*expectedRefundOperationKey/,
    'an external refund reward failure must create the exact recoverable refund lock');
  assert.match(rewardFailure, /financial_operation_type\s*=\s*'refund_owner'/);
  assert.match(rewardFailure, /financial_operation_started_at\s*=\s*new Date\(\)\.toISOString\(\)/);
  assert.match(rewardFailure, /rewardHoldQuery\.is\('financial_operation_started_at', null\)/,
    'the no-lock-to-refund-lock transition must CAS the complete prior tuple');
});

await check('owner cancellation rewards retry is exact, owner-only, and Stripe-free', () => {
  assert.match(ownerCancellation, /verifyOwner\(req\)/, 'the retry endpoint must remain owner authenticated');
  assert.match(
    cancellationCredits,
    new RegExp(`export\\s+const\\s+CANCELLATION_REWARDS_RECONCILIATION_REASON\\s*=\\s*['"]${CANCELLATION_REWARDS_RECONCILIATION_REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
    'the canonical persisted reason must have one exported server source of truth',
  );
  const recovery = between(ownerCancellation, 'const cancellationRewardsRecovery =', 'const transitionErr =');
  assert.match(recovery, /booking\.status\s*===\s*BOOKING_STATUS\.CANCELLED/);
  assert.match(recovery, /\['cancel_owner', 'cancel_customer', 'cancel_guest'\]\.includes\(booking\.financial_operation_type\)/);
  assert.match(recovery, /!!booking\.financial_operation_key/);
  assert.match(recovery, /booking\.financial_reconciliation_reason\s*===\s*CANCELLATION_REWARDS_RECONCILIATION_REASON/);
  assert.match(recovery, /await reconcileCancellationAssembleCash\(/);
  assert.match(recovery, /return res\.status\(credits\.ok \? 200 : 202\)/);
  assert.doesNotMatch(recovery, /new Stripe|paymentIntents|refunds\.|\.capture\(|\.cancel\(|reserveBookingFinancialOperation/,
    'rewards-only recovery must return before any Stripe or new financial reservation work');
});

await check('owner UI offers only the exact rewards retry during a cancellation reward hold', () => {
  const renderActionsSource = extractJsFunction(ownerUi, 'renderActions', 'var pendingAction = null;');
  assert.match(renderActionsSource, /b\.status\s*===\s*'cancelled'/,
    'the owner retry must not appear for a non-cancelled booking');
  assert.match(renderActionsSource, /b\.financial_reconciliation_reason\s*===\s*['"]AssembleCash cancellation reconciliation did not complete\. Do not retry payment, refund, or payout actions until reviewed\.['"]/);
  assert.match(renderActionsSource, /btns\s*=\s*cancellationRewardsRecovery[\s\S]*Retry Rewards Reconciliation[\s\S]*refundRecovery[\s\S]*Resume \/ Reconcile Refund/,
    'a generic financial hold must replace, not append to, booking actions');

  const detail = { innerHTML: '', style: {} };
  const esc = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  const renderActions = new Function('$detailAct', 'esc', `${renderActionsSource}\nreturn renderActions;`)(detail, esc);

  renderActions({
    id: 'booking-cancelled-reward-hold',
    status: 'cancelled',
    payment_status: 'refunded',
    customer_email: 'customer@example.com',
    financial_operation_key: 'cancel:owner:booking-cancelled-reward-hold',
    financial_operation_type: 'cancel_owner',
    financial_reconciliation_reason: CANCELLATION_REWARDS_RECONCILIATION_REASON,
    cancellation_reconciliation_required_at: null,
  });
  assert.equal(countButtons(detail.innerHTML), 1, 'the reward hold must expose exactly one owner action');
  assert.match(detail.innerHTML, /data-action="cancel"[^>]*>Retry Rewards Reconciliation<\/button>/);
  assert.doesNotMatch(detail.innerHTML, /Reset Customer Password|Refund Customer|Payout|Edit|Decline|Dispatch/);

  renderActions({
    id: 'booking-generic-financial-hold',
    status: 'completed',
    payment_status: 'captured',
    customer_email: 'customer@example.com',
    assembler_id: 'easer-1',
    payout_mode_snapshot: 'manual',
    financial_operation_key: 'refund:owner:booking-generic-financial-hold:total:1000',
    financial_operation_type: 'refund_owner',
    financial_reconciliation_reason: 'Refund reconciliation is pending.',
    cancellation_reconciliation_required_at: null,
  });
  assert.equal(countButtons(detail.innerHTML), 1, 'an exact refund hold must expose only its safe recovery action');
  assert.match(detail.innerHTML, /data-action="refund-recovery"[^>]*>Resume \/ Reconcile Refund<\/button>/);
  assert.doesNotMatch(detail.innerHTML, /Reset Customer Password|Refund Customer|Payout|Edit|Decline|Dispatch/);
});

await check('refund holds are owner-visible, recoverable, and block payout review', () => {
  const renderActionsSource = extractJsFunction(ownerUi, 'renderActions', 'var pendingAction = null;');
  assert.match(renderActionsSource, /financial_operation_key\s*\|\|\s*b\.financial_reconciliation_required_at/,
    'owner detail must surface malformed no-lock reconciliation holds');
  assert.match(ownerLiveOps, /bookings\.filter\(booking\s*=>\s*booking\.financial_reconciliation_required_at\)/,
    'Live Ops must alert on reconciliation markers even when the lock tuple is malformed');
  assert.match(ownerLiveOps, /malformed financial reconciliation hold/i);
  assert.match(payoutReview, /booking\.financial_operation_key\s*\|\|\s*booking\.financial_reconciliation_required_at/,
    'payout review must fail closed on both exact and malformed financial holds');

  const reserveSql = sqlFunction(migration037, 'reserve_booking_financial_operation');
  assert.match(
    reserveSql,
    /financial_reconciliation_required_at\s+IS\s+NOT\s+NULL[\s\S]*financial_operation_key\s+IS\s+NULL[\s\S]*malformed financial reconciliation hold/i,
    'new money operations must fail closed on a no-lock reconciliation marker',
  );
});

await check('owner UI never reports a 202 reconciliation response as success', () => {
  const doAction = extractJsFunction(ownerUi, 'doAction', '//');
  assert.match(doAction, /data\.success\s*===\s*false/);
  assert.match(doAction, /data\.reconciliationRequired/);
  assert.match(ownerUi, /rd\.success\s*===\s*false\s*\|\|\s*rd\.reconciliationRequired\s*\|\|\s*rd\.financialReconciliationRequired/);
});

await check('migration 037 defines atomic AssembleCash booking reconciliation with the shared email lock', () => {
  const reconcileSql = sqlFunction(migration037, 'assemblecash_reconcile_booking_credits');
  assert.match(reconcileSql, /SECURITY\s+DEFINER/i);
  assert.match(reconcileSql, /SET\s+search_path\s*=\s*pg_catalog\s*,\s*public/i);
  assert.match(reconcileSql, /LOWER\s*\(\s*TRIM/i, 'reconciliation must normalize the customer email');
  assert.match(
    reconcileSql,
    /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*v_email\s*,\s*28025\s*\)\s*\)/i,
    'reconciliation must share assemblecash_try_redeem email lock 28025',
  );
  assert.match(reconcileSql, /booking_id\s*=\s*p_booking_id/i);
  assert.match(reconcileSql, /amount_earned_cents\s*>\s*0/i);
  assert.match(reconcileSql, /assemblecash_earned_cents/i);
  assert.match(reconcileSql, /v_earned_reconciled/i);
  assert.match(reconcileSql, /p_release_redemption/i);
  assert.match(reconcileSql, /amount_redeemed_cents\s*>\s*0/i);
  assert.match(reconcileSql, /assemblecash_redeemed_cents/i);
  assert.match(reconcileSql, /v_redemption_reconciled/i);
  assertServiceRoleOnly('assemblecash_reconcile_booking_credits');
});

await check('migration 037 available balance excludes unsafe reward sources but keeps debit rows', () => {
  const balanceSql = sqlFunction(migration037, 'assemblecash_available_balance');
  assertRewardSourceExclusions(balanceSql, 'assemblecash_available_balance');
  assertServiceRoleOnly('assemblecash_available_balance');
});

await check('migration 037 redemption recheck excludes unsafe reward sources but keeps debit rows', () => {
  const redeemSql = sqlFunction(migration037, 'assemblecash_try_redeem');
  assert.match(
    redeemSql,
    /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*v_email\s*,\s*28025\s*\)\s*\)/i,
    'redemption must retain email lock 28025',
  );
  assertRewardSourceExclusions(redeemSql, 'assemblecash_try_redeem');
  assert.match(redeemSql, /INSERT\s+INTO\s+(?:public\.)?assemblecash_ledger/i);
  assertServiceRoleOnly('assemblecash_try_redeem');
});

if (failures.length) {
  console.error(`\nReward reconciliation safety findings: ${failures.length}`);
  for (const { name, error } of failures) {
    console.error(`- ${name}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nReward reconciliation lock, RPC, migration, and owner-retry safety checks passed.');
}
