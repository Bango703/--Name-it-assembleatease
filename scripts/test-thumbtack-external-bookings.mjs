#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { isThumbtackLiveFlow } from '../api/_owner-easer.js';
import { normalizeOwnerOfflinePaymentMethod, offlineMethodFeeCents } from '../api/owner/_offline-payment.js';
import { hasVerifiedOfflineOwnerPayment } from '../api/owner/_finance-ledger.js';

const booking = {
  source: 'owner_manual',
  payment_status: 'offline_recorded',
  payment_method: 'thumbtack',
  external_platform: 'thumbtack',
  external_agreement_verified_at: '2026-10-25T12:00:00Z',
};
const readyEaser = { role: 'assembler', is_owner: false, is_demo_account: false };

assert.equal(normalizeOwnerOfflinePaymentMethod('thumbtack'), 'thumbtack');
assert.equal(offlineMethodFeeCents('thumbtack', 16238), 0, 'Thumbtack must not be labeled an AAE Stripe processing fee');
assert.equal(isThumbtackLiveFlow(booking, readyEaser), true);
for (const unsafe of [
  { ...booking, source: 'online' },
  { ...booking, payment_status: 'captured' },
  { ...booking, external_platform: null },
  { ...booking, external_agreement_verified_at: null },
  { ...booking, payment_method: 'invoice' },
]) assert.equal(isThumbtackLiveFlow(unsafe, readyEaser), false);
assert.equal(isThumbtackLiveFlow(booking, { ...readyEaser, is_demo_account: true }), false);
assert.equal(isThumbtackLiveFlow(booking, { ...readyEaser, is_owner: true }), false);

const collected = {
  ...booking,
  payment_collected: true,
  payment_collected_at: '2026-10-27T15:00:00Z',
  payment_collected_by: 'owner',
  amount_charged: 16238,
  total_price: 16238,
  external_payment_reference: 'TT-PAYOUT-123',
};
assert.equal(hasVerifiedOfflineOwnerPayment(collected), true);
assert.equal(hasVerifiedOfflineOwnerPayment({ ...collected, external_payment_reference: null }), false);
assert.equal(hasVerifiedOfflineOwnerPayment({ ...collected, external_platform: null }), false);

const [createApi, assignApi, acceptApi, completionApi, collectApi, migration, ownerHtml] = await Promise.all([
  fs.readFile(new URL('../api/owner/create-booking.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/booking/assign.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/booking/accept-dispatch.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/booking/assembler-complete.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/owner/mark-payment-collected.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/migrations/120_thumbtack_external_bookings.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
]);

assert.match(createApi, /external_agreement_verified_at: isThumbtackBooking \? now : null/);
assert.match(createApi, /!isThumbtackBooking && !isAlreadyCompleted && cleanEmail/);
assert.match(assignApi, /isThumbtackLiveFlow\(booking, assembler\)/);
assert.match(acceptApi, /isOfflineLiveFlow\(sb, booking, actorProfile\)/);
assert.match(completionApi, /booking\.external_platform !== 'thumbtack'/);
assert.match(collectApi, /THUMBTACK_PAYMENT_REFERENCE_REQUIRED/);
assert.match(migration, /external_payment_reference/);
assert.match(migration, /bookings_payment_method_check/);
assert.match(migration, /record_booking_payout/);
assert.match(ownerHtml, /ocb-external-agreement/);
assert.match(ownerHtml, /Customer communication stays in Thumbtack/);
assert.match(ownerHtml, /collection-reference/);
assert.match(ownerHtml, /thumbtackLiveAssignment = b\.source === 'owner_manual'[\s\S]*?b\.external_platform === 'thumbtack'[\s\S]*?eligibleAssemblers\.filter\(function\(a\) \{\s*if \(thumbtackLiveAssignment\) return a\.is_owner !== true && a\.is_demo_account !== true;/,
  'verified Thumbtack bookings must offer ready real Easers without opening owner-manual assignment to other booking types');

console.log('PASS: Thumbtack booking consent, assignment, payment, and payout gates');
