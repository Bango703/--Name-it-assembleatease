import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getEaserReadiness } from '../api/_easer-readiness.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { canTransitionBookingStatus } from '../api/booking/_workflow-engine.js';
import { redactAssignmentCustomerData } from '../api/booking/my-assignments.js';
import { validatePublishedRescheduleSlot } from '../api/booking/reschedule.js';

const baseProfile = {
  id: 'easer-1',
  status: 'active',
  application_status: 'approved',
  tier: 'starter',
  phone: '7375550100',
  is_available: true,
  identity_verified: true,
  contractor_agreement_signed_at: '2026-07-12T12:00:00.000Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-07-12T12:00:00.000Z',
};

const manualReady = await getEaserReadiness(baseProfile, { connectRequired: false });
assert.equal(manualReady.isReady, true, 'manual payout readiness must not require Connect');

const offline = await getEaserReadiness({ ...baseProfile, is_available: false }, { connectRequired: false });
assert.equal(offline.isReady, false);
assert.ok(offline.missingItems.includes('Online and available'));

const staleAgreement = await getEaserReadiness({
  ...baseProfile,
  contractor_agreement_version: '2026-06-08',
}, { connectRequired: false });
assert.equal(staleAgreement.isReady, false);
assert.ok(staleAgreement.missingItems.some(item => item.includes(CONTRACTOR_AGREEMENT_VERSION)));

const connectAccount = {
  details_submitted: true,
  charges_enabled: true,
  payouts_enabled: true,
  requirements: { currently_due: [], past_due: [], disabled_reason: null },
};
const connectReady = await getEaserReadiness({
  ...baseProfile,
  stripe_connect_account_id: 'acct_test',
}, { connectRequired: true, stripeAccount: connectAccount });
assert.equal(connectReady.isReady, true);

const connectBlocked = await getEaserReadiness({
  ...baseProfile,
  stripe_connect_account_id: 'acct_test',
}, {
  connectRequired: true,
  stripeAccount: {
    ...connectAccount,
    payouts_enabled: false,
    requirements: { currently_due: ['external_account'], past_due: [], disabled_reason: 'requirements.past_due' },
  },
});
assert.equal(connectBlocked.isReady, false);
assert.ok(connectBlocked.missingItems.includes('Stripe payouts enabled'));
assert.ok(connectBlocked.missingItems.some(item => item.startsWith('Stripe requirements due:')));

assert.equal(canTransitionBookingStatus('confirmed', 'en_route'), true);
assert.equal(canTransitionBookingStatus('confirmed', 'arrived'), false);
assert.equal(canTransitionBookingStatus('confirmed', 'completed'), false);
assert.equal(canTransitionBookingStatus('en_route', 'arrived'), true);
assert.equal(canTransitionBookingStatus('en_route', 'in_progress'), false);
assert.equal(canTransitionBookingStatus('arrived', 'in_progress'), true);
assert.equal(canTransitionBookingStatus('in_progress', 'completed'), true);

const redacted = redactAssignmentCustomerData([
  {
    status: 'completed', assembler_accepted_at: '2026-07-12T12:00:00Z',
    customer_name: 'Customer', customer_phone: '1', customer_email: 'c@example.com', address: 'Private', details: 'Private', assignment_token: 'secret',
  },
  {
    status: 'confirmed', assembler_accepted_at: null,
    customer_name: 'Customer', customer_phone: '1', customer_email: 'c@example.com', address: 'Private', details: 'Private', assignment_token: 'accept-token',
  },
  {
    status: 'in_progress', assembler_accepted_at: '2026-07-12T12:00:00Z',
    customer_name: 'Customer', customer_phone: '1', customer_email: 'c@example.com', address: 'Private', details: 'Private', assignment_token: null,
  },
]);
assert.equal(redacted[0].address, null, 'terminal jobs must not expose customer PII');
assert.equal(redacted[0].assignment_token, null, 'terminal jobs must not retain client-visible acceptance tokens');
assert.equal(redacted[1].customer_email, null, 'unaccepted jobs must not expose customer PII');
assert.equal(redacted[2].address, 'Private', 'accepted active jobs need operational address access');

assert.equal(validatePublishedRescheduleSlot('2026-07-13', '7:00 AM – 9:00 AM').ok, true, 'weekday slot');
assert.equal(validatePublishedRescheduleSlot('2026-07-18', '11:00 AM – 1:00 PM').ok, true, 'Saturday morning slot');
assert.equal(validatePublishedRescheduleSlot('2026-07-18', '1:00 PM – 3:00 PM').ok, false, 'Saturday afternoon closed');
assert.equal(validatePublishedRescheduleSlot('2026-07-19', '9:00 AM – 11:00 AM').ok, false, 'Sunday closed');

const [monitorSource, statusSource, assignmentUiSource, evidenceSource] = await Promise.all([
  readFile(new URL('../api/owner/monitor.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/easer-status.js', import.meta.url), 'utf8'),
  readFile(new URL('../assembler/my-assignments.html', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/upload-evidence.js', import.meta.url), 'utf8'),
]);
assert.equal(monitorSource.includes('dispatchBooking('), false, 'owner analysis must be read-only');
assert.equal(statusSource.includes('update.assembler_accepted_at'), false, 'status updates must not synthesize acceptance');
assert.equal(assignmentUiSource.includes('b.assembler_accepted_at || b.assigned_at'), false, 'UI must not treat assignment as acceptance');
assert.ok(evidenceSource.includes("evidenceType === 'damage_claim' && cleanNotes.length < 10"));

console.log('operations truth tests: PASS');
