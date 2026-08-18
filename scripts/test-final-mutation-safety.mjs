import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertNullFinancialLockTuple(source, label) {
  assert.match(source, /\.is\('financial_operation_key', null\)/, `${label} must CAS the financial operation key`);
  assert.match(source, /\.is\('financial_operation_type', null\)/, `${label} must CAS the financial operation type`);
  assert.match(source, /\.is\('financial_operation_started_at', null\)/, `${label} must CAS the financial operation start time`);
}

const [webhook, ownerEdit, reschedule, reminders, tierCheck] = await Promise.all([
  load('api/assembler/stripe-webhook.js'),
  load('api/owner/edit-booking.js'),
  load('api/booking/reschedule.js'),
  load('api/cron/reminders.js'),
  load('api/cron/tier-check.js'),
]);

const failedMutation = section(
  webhook,
  "const { data: failedRows, error: failedUpdateError }",
  "const { error: offerCancelError }",
);
assertNullFinancialLockTuple(failedMutation, 'failed-payment webhook mutation');
assert.match(failedMutation, /if \(!failedRows\?\.length\)[\s\S]*reason: 'financial-operation-reserved-during-webhook'[\s\S]*break;/);
assert.ok(failedMutation.indexOf("if (!failedRows?.length)") >= 0, 'a failed-payment lock race must stop before offer cancellation and notifications');

const canceledMutation = section(
  webhook,
  "const { data: canceledRows, error: canceledUpdateError }",
  "const { error: canceledOffersError }",
);
assertNullFinancialLockTuple(canceledMutation, 'canceled-payment webhook mutation');
assert.match(canceledMutation, /if \(!canceledRows\?\.length\)[\s\S]*reason: 'financial-operation-reserved-during-webhook'[\s\S]*break;/);

assert.match(ownerEdit, /\['en_route', 'arrived', 'in_progress'\]/);
assert.match(ownerEdit, /code: 'BOOKING_SCOPE_LOCKED'/);
assert.match(ownerEdit, /hasBookingPaymentState\(booking\) \|\| assignmentExists/);
assert.match(ownerEdit, /updates\.reminder_sent = false/);
// A schedule change still forces Easer reconfirmation on every real assigned
// job. The only exemption is a record-only owner-manual (offline) booking,
// where the owner performed the work and no live Easer must be re-notified.
assert.match(ownerEdit, /easerReconfirmationRequired = Boolean\(!recordOnlyOwnerManual && scheduleChanged && booking\.assembler_id\)/);
assert.match(
  ownerEdit,
  /recordOnlyOwnerManual\s*=\s*[\s\S]{0,160}?'owner_manual'/,
  'the owner-edit reconfirmation bypass must be scoped to owner_manual bookings',
);
assert.match(ownerEdit, /notificationType: 'owner_edit_easer_reconfirmation'/);
assert.match(ownerEdit, /\.update\(\{ offer_status: 'cancelled' \}\)/);
assertNullFinancialLockTuple(ownerEdit, 'owner booking edit mutation');
for (const stateColumn of ['payment_status', 'assembler_accepted_at', 'dispatch_attempt', 'dispatch_paused', 'needs_manual_dispatch']) {
  assert.match(ownerEdit, new RegExp(`\\['${stateColumn}', booking\\.${stateColumn}\\]`), `owner edit must CAS ${stateColumn}`);
}

assert.match(reschedule, /reconfirmationRequired = Boolean\(booking\.assembler_id\)/);
assert.doesNotMatch(reschedule, /booking\.assembler_id && booking\.assembler_accepted_at/);
assert.match(reschedule, /reminder_sent: false/);
assert.match(reschedule, /dispatch_attempt: currentDispatchAttempt \+ 1/);
assert.match(reschedule, /\.update\(\{ offer_status: 'cancelled' \}\)/);
assert.match(reschedule, /notificationType: 'reschedule_easer_reconfirmation'/);
assertNullFinancialLockTuple(reschedule, 'customer reschedule mutation');
for (const stateColumn of ['guest_mutation_token_hash', 'assembler_accepted_at', 'dispatch_attempt', 'dispatch_paused', 'needs_manual_dispatch', 'reminder_sent']) {
  assert.match(reschedule, new RegExp(`\\['${stateColumn}', booking\\.${stateColumn}\\]`), `reschedule must CAS ${stateColumn}`);
}

assert.match(reminders, /\.eq\('status', booking\.status\)/);
assert.match(reminders, /\.eq\('date', booking\.date\)/);
assert.match(reminders, /\.eq\('reminder_sent', false\)/);
assert.match(reminders, /booking\.time == null[\s\S]*\.is\('time', null\)[\s\S]*\.eq\('time', booking\.time\)/);
assert.match(reminders, /if \(!flaggedRows\?\.length\)/);

const promotionMutation = section(tierCheck, 'if (di > ci)', '} else if (di < ci)');
assert.match(promotionMutation, /\.update\(\{ tier: deserved,/);
assert.match(promotionMutation, /\.eq\('id', p\.id\)/);
assert.match(promotionMutation, /\.eq\('status', 'active'\)/);
assert.match(promotionMutation, /\.eq\('tier', current\)/);
assert.match(promotionMutation, /\.select\('id'\)/);
assert.match(promotionMutation, /results\.promoted\+\+/);

const demotionMutation = section(tierCheck, '} else if (di < ci)', '} else if (p.tier_grace_started_at)');
assert.match(demotionMutation, /const newTier = TIER_ORDER\[ci - 1\]/);
assert.match(demotionMutation, /\.update\(\{ tier: newTier,/);
assert.match(demotionMutation, /\.eq\('id', p\.id\)/);
assert.match(demotionMutation, /\.eq\('status', 'active'\)/);
assert.match(demotionMutation, /\.eq\('tier', current\)/);
assert.match(demotionMutation, /\.select\('id'\)/);
assert.match(demotionMutation, /results\.demoted\+\+/);

console.log('final mutation safety tests: PASS');
