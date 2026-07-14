import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [expirySource, reauthSource, migration] = await Promise.all([
  load('api/cron/stale-booking.js'),
  load('api/cron/reauth-payments.js'),
  load('api/migrations/037_owner_easer_workflow_completion.sql'),
]);

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

check('pending-payment expiry owns its exact operation before Stripe work', () => {
  const reserveIndex = expirySource.indexOf('await reserveBookingFinancialOperation(sb, {');
  const stripeIndex = expirySource.indexOf('await prepareExternalPaymentForExpiry', reserveIndex);
  assert.ok(reserveIndex >= 0 && stripeIndex > reserveIndex);
  assert.match(expirySource, /const operationKey = `expire:pending:\$\{b\.id\}`/);
  assert.match(expirySource, /operationType: 'expire_payment'/);
  assert.match(expirySource, /\.eq\('financial_operation_key', operationKey\)[\s\S]*?\.eq\('financial_operation_type', 'expire_payment'\)/);
});

check('ambiguous expiry retains a durable owner-visible reconciliation hold', () => {
  assert.match(expirySource, /mutationAmbiguous/);
  assert.match(expirySource, /holdExpiryForReconciliation/);
  assert.match(expirySource, /financial_reconciliation_required_at/);
  assert.match(expirySource, /financial_reconciliation_reason/);
  assert.match(expirySource, /releaseBookingFinancialOperation/);
});

check('reauthorization reserves exact state before any replacement creation', () => {
  const reserveIndex = reauthSource.indexOf('await reserveBookingFinancialOperation(sb, {');
  const createIndex = reauthSource.indexOf('stripe.paymentIntents.create', reserveIndex);
  assert.ok(reserveIndex >= 0 && createIndex > reserveIndex);
  assert.match(reauthSource, /const operationKey = `reauth:\$\{booking\.id\}`/);
  assert.match(reauthSource, /const REAUTH_OPERATION_TYPE = 'reauth_payment'/);
  assert.match(reauthSource, /\.eq\('financial_operation_key', operationKey\)[\s\S]*?\.eq\('financial_operation_type', REAUTH_OPERATION_TYPE\)/);
});

check('reauthorization validates Stripe identity and financial truth', () => {
  for (const marker of [
    'capture_method',
    'currency',
    'livemode',
    'metadata_booking_id',
    'metadata_booking_ref',
    'metadata_type',
    'metadata_replaces',
  ]) assert.ok(reauthSource.includes(marker), `missing validation marker ${marker}`);
  assert.match(reauthSource, /financial_reconciliation_required_at/);
  assert.match(reauthSource, /financial_reconciliation_reason/);
});

check('migration 037 constrains both background operation identities', () => {
  assert.match(migration, /'reauth_payment', 'expire_payment'/);
  assert.match(migration, /'reauth:' \|\| v_booking\.id::TEXT/);
  assert.match(migration, /'expire:pending:' \|\| v_booking\.id::TEXT/);
});

if (failures.length) {
  console.error(`\nBackground payment-lock checks failed: ${failures.length}`);
  process.exitCode = 1;
} else {
  console.log('\nBackground payment reservation and reconciliation checks passed.');
}
