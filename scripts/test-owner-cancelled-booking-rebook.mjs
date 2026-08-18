import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  normalizeRebookSourceId,
  validateOwnerRebookSource,
} from '../api/owner/_rebook.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const cancelled = {
  id: UUID,
  ref: 'AAE-CANCELLED',
  status: 'cancelled',
  source: 'online',
  payment_status: 'authorization_released',
  stripe_payment_intent_id: 'pi_released',
  financial_operation_key: null,
  financial_reconciliation_required_at: null,
  cancellation_reconciliation_required_at: null,
};

assert.equal(normalizeRebookSourceId(UUID), UUID);
assert.equal(normalizeRebookSourceId('not-a-booking-id'), null);
assert.equal(validateOwnerRebookSource(cancelled).ok, true);
assert.equal(validateOwnerRebookSource({ ...cancelled, status: 'confirmed' }).code, 'REBOOK_CANCELLED_SOURCE_REQUIRED');
assert.equal(validateOwnerRebookSource({ ...cancelled, financial_operation_key: 'cancel:owner:1' }).code, 'REBOOK_SOURCE_RECONCILIATION_REQUIRED');
assert.equal(validateOwnerRebookSource({ ...cancelled, payment_status: 'authorized' }).code, 'REBOOK_SOURCE_PAYMENT_UNSETTLED');
assert.equal(validateOwnerRebookSource({ ...cancelled, payment_status: 'cancellation_fee_captured' }).ok, true);
assert.equal(validateOwnerRebookSource({
  ...cancelled,
  source: 'owner_manual',
  stripe_payment_intent_id: null,
  payment_status: 'offline_recorded',
  payment_collected: true,
  amount_charged: 15_000,
  refund_amount: 0,
}).code, 'REBOOK_SOURCE_OFFLINE_PAYMENT_UNSETTLED');
assert.equal(validateOwnerRebookSource({
  ...cancelled,
  source: 'owner_manual',
  stripe_payment_intent_id: null,
  payment_status: 'offline_recorded',
  payment_collected: true,
  amount_charged: 15_000,
  refund_amount: 15_000,
}).ok, true);

const [ownerUi, createApi, migration] = await Promise.all([
  readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/create-booking.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/067_cancelled_booking_rebook_lineage.sql', import.meta.url), 'utf8'),
]);

assert.match(ownerUi, /data-action="rebook"/);
assert.match(ownerUi, /Review &amp; Rebook/);
assert.match(ownerUi, /data-action="open-rebooking"/);
assert.match(ownerUi, /item\.rebooked_from_booking_id === b\.id/);
assert.match(ownerUi, /function openOwnerCreateBookingModal\(rebookSource\)/);
assert.match(ownerUi, /No old payment or Easer assignment will be reused/);
assert.match(ownerUi, /rebookedFromBookingId:/);
assert.match(ownerUi, /sourceInput\.value = rebookSource\.id/);
assert.match(ownerUi, /setValue\('ocb-details', rebookSource\.details \|\| ''\)/);
assert.match(ownerUi, /methodInput\.value = ''/);
assert.match(ownerUi, /customerTerms\.checked = false/);
assert.match(ownerUi, /d\.code === 'REBOOK_ALREADY_CREATED'/);
assert.match(ownerUi, /selectBooking\(d\.existingBookingId\)/);

assert.match(createApi, /validateOwnerRebookSource\(sourceBooking\)/);
assert.match(createApi, /code: 'REBOOK_MUST_BE_NEW_APPOINTMENT'/);
assert.match(createApi, /cleanDate < chicagoDateIso\(\)/);
assert.match(createApi, /insertPayload\.rebooked_from_booking_id = rebookSource\.id/);
assert.match(createApi, /details: cleanDetails/);
assert.match(createApi, /eventType: 'booking_rebooked'/);
assert.match(createApi, /paymentReused: false/);
assert.match(createApi, /assignmentReused: false/);
assert.match(createApi, /No payment or authorization from the cancelled booking was reused/);
assert.match(createApi, /code: 'REBOOK_ALREADY_CREATED'/);
assert.doesNotMatch(createApi, /insertPayload\.(?:stripe_payment_intent_id|assembler_id|refund_id|payout_status)\s*=/);

assert.match(migration, /rebooked_from_booking_id UUID REFERENCES public\.bookings\(id\) ON DELETE SET NULL/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_rebooked_from_booking_id/);
assert.match(migration, /bookings_rebook_source_not_self/);
assert.match(migration, /VALUES \(67, 'cancelled_booking_rebook_lineage'\)/);
assert.equal((migration.match(/^BEGIN;$/gm) || []).length, 1);
assert.equal((migration.match(/^COMMIT;$/gm) || []).length, 1);

console.log('Owner cancelled-booking rebook lineage and payment-isolation checks: PASS');
