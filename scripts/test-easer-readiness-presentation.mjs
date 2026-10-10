import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  EASER_REQUIREMENTS_FIELDS, getEaserReadiness, getEaserApprovalReadiness,
} from '../api/_easer-readiness.js';
import { EASER_READINESS_FIELDS } from '../api/_easer-readiness-select.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { normalizeAssemblerProfile } from '../api/_assembler-state.js';
import { hasEffectiveEaserMembership } from '../api/_easer-membership.js';

const baseProfile = {
  ...Object.fromEntries(EASER_READINESS_FIELDS.map(field => [field, null])),
  id: 'easer-ready', role: 'assembler', full_name: 'Test Easer',
  status: 'active', application_status: 'approved', tier: 'starter',
  is_available: true, identity_verified: true, phone: '7375550100',
  sms_consent_at: '2026-09-01T12:00:00Z', sms_opted_out_at: null,
  contractor_agreement_signed_at: '2026-09-01T12:00:00Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-09-01T12:00:00Z',
  application_fee_paid: false, payment_confirmed: false,
  application_fee_waived: true, fee_waived_by_owner: false,
  application_fee_refunded: false, application_fee_refunded_cents: 0,
  application_fee_refund_pending_cents: 0,
};
const read = (profile, options = {}) => getEaserReadiness(profile, {
  connectRequired: false, stripeAccount: null, ...options,
});

// Availability changes offer eligibility, never the list of setup requirements.
for (const available of [true, false]) {
  for (const requireAvailability of [true, false]) {
    const result = await read({ ...baseProfile, is_available: available }, { requireAvailability });
    assert.equal(result.requirementsVerified, true);
    assert.equal(result.requirementsReady, true);
    assert.deepEqual(result.requirementsMissingItems, []);
    assert.equal(result.offerStatus, available ? 'ready' : 'offline');
    assert.equal(result.isReady, available || !requireAvailability);
    assert.deepEqual(result.missingItems, available || !requireAvailability ? [] : ['Online and available']);
    assert.equal(result.finalStatus, result.isReady ? 'READY FOR JOBS' : 'ACTION REQUIRED');
  }
}

// Every real job proof field must be loaded; null and false are stored evidence,
// but missing, inherited, and undefined values cannot support a ready label.
// 21 since migration 108 added profile_photo_requested_at (owner photo request).
assert.equal(EASER_REQUIREMENTS_FIELDS.length, 21);
for (const field of EASER_REQUIREMENTS_FIELDS) {
  for (const storedValue of [null, false]) {
    assert.equal((await read({ ...baseProfile, [field]: storedValue })).requirementsVerified, true,
      `${field}: stored ${storedValue} is evidence, even when it fails a requirement`);
  }
  for (const missingKind of ['omitted', 'undefined', 'inherited']) {
    const profile = { ...baseProfile };
    if (missingKind === 'undefined') profile[field] = undefined;
    else delete profile[field];
    if (missingKind === 'inherited') Object.setPrototypeOf(profile, { [field]: baseProfile[field] });
    const result = await read(profile);
    assert.equal(result.requirementsVerified, false, `${field}: ${missingKind} evidence`);
    assert.equal(result.requirementsReady, null);
    assert.equal(result.offerStatus, 'unverified');
    assert.deepEqual(result.requirementsMissingItems, []);
  }
}
for (const optionalField of ['payment_confirmed', 'stripe_connect_account_id']) {
  const profile = { ...baseProfile };
  delete profile[optionalField];
  const result = await read(profile);
  assert.equal(result.requirementsVerified, true, `${optionalField} is not a job gate`);
  assert.equal(result.offerStatus, 'ready');
}
const legacyProjection = { ...baseProfile };
for (const field of ['application_fee_paid', 'application_fee_waived', 'fee_waived_by_owner']) delete legacyProjection[field];
const legacy = await read(legacyProjection);
assert.equal(legacy.isReady, true, 'presentation must not redefine the legacy dispatch predicate');
assert.equal(legacy.requirementsReady, null, 'legacy predicate is not proof of complete requirements');

const blockers = [
  [{ application_status: 'pending' }, 'Application submitted'],
  [{ contractor_agreement_signed_at: null }, 'Contractor agreement accepted'],
  [{ contractor_agreement_version: 'outdated' }, `Current contractor agreement accepted (${CONTRACTOR_AGREEMENT_VERSION})`],
  [{ code_of_conduct_agreed_at: null }, 'Code of conduct accepted'],
  [{ identity_verified: false }, 'Identity verified'],
  [{ status: 'suspended' }, 'Owner approved'],
  [{ status: 'deactivated' }, 'Owner approved'],
  [{ status: null }, 'Owner approved'],
  [{ status: 'legacy-unknown' }, 'Owner approved'],
  [{ tier: null }, 'Valid Easer tier'],
  [{ phone: null }, 'Valid 10-digit U.S. phone number on file'],
  [{ sms_consent_at: null }, 'Job texts enabled'],
  [{ sms_opted_out_at: '2026-09-01T13:00:00Z' }, 'Job texts enabled'],
  [{ application_fee_waived: false }, 'Application fee paid or explicitly waived'],
  [{ application_fee_refunded: true }, 'Application fee refund resolved (a refund is recorded, pending, or under review)'],
  [{ application_fee_refund_pending_cents: 3000 }, 'Application fee refund resolved (a refund is recorded, pending, or under review)'],
  [{ application_decision_key: 'decision-in-progress' }, 'Application decision finished (one is still in progress)'],
  ...['requested', 'reviewing', 'completed'].map(value => [{ account_closure_status: value }, `Account closure ${value}`]),
];
for (const [patch, expectedItem] of blockers) {
  for (const available of [true, false]) {
    const result = await read({ ...baseProfile, ...patch, is_available: available });
    assert.equal(result.requirementsVerified, true);
    assert.equal(result.requirementsReady, false);
    assert.equal(result.isReady, false);
    assert.equal(result.offerStatus, 'action_required');
    assert.ok(result.requirementsMissingItems.includes(expectedItem), expectedItem);
    assert.ok(!result.requirementsMissingItems.includes('Online and available'));
  }
}
assert.equal((await read({ ...baseProfile, account_closure_status: 'cancelled' })).offerStatus, 'ready');

const taxAccount = {
  details_submitted: true, charges_enabled: true, payouts_enabled: false,
  requirements: { currently_due: ['individual.ssn_last_4'], past_due: [], disabled_reason: null },
};
const payoutOnly = await read({ ...baseProfile, stripe_connect_account_id: 'acct_test' }, {
  connectRequired: true, stripeAccount: taxAccount,
});
assert.equal(payoutOnly.offerStatus, 'ready');
assert.equal(payoutOnly.isReady, true);
assert.equal(payoutOnly.payoutSetupComplete, false);
assert.ok(payoutOnly.payoutSetupItems.includes('Stripe payouts enabled'));
assert.deepEqual(payoutOnly.requirementsMissingItems, []);

// Execute the real handlers with their imports replaced by explicit local
// dependencies. No environment credentials, network, or live writes are used.
async function loadHandler(relativePath, dependencies) {
  const source = (await readFile(new URL(relativePath, import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace('export default async function handler', 'async function handler');
  return vm.runInNewContext(`${source}\nhandler`, {
    ...dependencies,
    console: { error() {} },
    process: { env: { STRIPE_SECRET_KEY: 'local-test-key' } },
  }, { filename: relativePath });
}

async function callHandler(kind, profiles, options = {}) {
  const calls = { reads: [], updates: [], stripe: [], db: 0 };
  const connectRequired = options.connectRequired === true;
  const sb = {
    from(table) {
      assert.equal(table, 'profiles');
      calls.db += 1;
      let update = null;
      const query = {
        select(columns) { calls.reads.push(['select', columns]); return query; },
        eq(column, value) { calls.reads.push(['eq', column, value]); return query; },
        order() { return query; },
        ilike() { return query; },
        update(values) { update = values; calls.updates.push(values); return query; },
        maybeSingle() { return Promise.resolve({ data: profiles[0] ? { ...profiles[0] } : null, error: options.error || null }); },
        then(resolve, reject) {
          return Promise.resolve({ data: update ? null : profiles.map(profile => ({ ...profile })), error: options.error || null })
            .then(resolve, reject);
        },
      };
      return query;
    },
  };
  class MockStripe {
    accounts = { retrieve: async id => {
      calls.stripe.push(id);
      if (options.stripeError) throw new Error('Mock Stripe unavailable');
      return options.account || taxAccount;
    } };
  }
  const handler = await loadHandler(kind === 'list' ? '../api/assembler/list.js' : '../api/owner/easer-readiness.js', {
    getSupabase: () => sb,
    verifyOwner: () => options.authorized !== false,
    isStripeConnectEnabled: () => connectRequired,
    normalizeAssemblerProfile, hasEffectiveEaserMembership, getEaserApprovalReadiness,
    getEaserReadiness: (profile, args) => getEaserReadiness(profile, { ...args, stripeClient: new MockStripe() }),
    Stripe: MockStripe,
    isSmsEnabled: () => true,
    smsEligibility: () => ({ ok: true }),
  });
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
  await handler({ method: options.method || 'GET', query: { assemblerId: baseProfile.id } }, res);
  return { ...res, calls };
}

for (const available of [true, false]) {
  const profile = { ...baseProfile, is_available: available };
  const list = await callHandler('list', [profile]);
  const detail = await callHandler('detail', [profile]);
  assert.equal(list.statusCode, 200);
  assert.equal(detail.statusCode, 200);
  for (const readiness of [list.body.assemblers[0].readiness, detail.body.readiness]) {
    assert.equal(readiness.offerStatus, available ? 'ready' : 'offline');
    assert.equal(readiness.requirementsReady, true);
    assert.equal(readiness.isReady, available);
  }
  assert.equal(list.body.stats.dispatchEligible, available ? 1 : 0);
  assert.equal(detail.body.readiness.taxReadinessStatus, 'W-9 Not Requested');
  assert.deepEqual(list.calls.updates, []);
  assert.deepEqual(detail.calls.updates, []);
  assert.deepEqual(list.calls.stripe, []);
  assert.deepEqual(detail.calls.stripe, []);
  assert.ok(list.calls.reads.some(call => call[0] === 'eq' && call[1] === 'role' && call[2] === 'assembler'));
}

for (const rawStatus of [null, 'legacy-unknown']) {
  const list = await callHandler('list', [{
    ...baseProfile, status: rawStatus, identity_resume_token: 'secret',
    contractor_agreement_ip: 'private', contractor_agreement_user_agent: 'private',
  }]);
  const person = list.body.assemblers[0];
  assert.equal(person.status, 'active', 'existing normalized display is retained');
  assert.equal(person.readiness.ownerApproved, false, 'tier cannot manufacture raw approval evidence');
  assert.equal(person.readiness.offerStatus, 'action_required');
  assert.equal(person.readiness.isReady, false);
  assert.equal(list.body.stats.dispatchEligible, 0);
  assert.deepEqual(person.approvalReadiness, getEaserApprovalReadiness(normalizeAssemblerProfile({ ...baseProfile, status: rawStatus })));
  for (const secret of ['identity_resume_token', 'contractor_agreement_ip', 'contractor_agreement_user_agent']) {
    assert.equal(Object.hasOwn(person, secret), false);
  }
}
for (const profile of [
  { ...baseProfile, identity_verified: false },
  { ...baseProfile, status: 'suspended' },
  { ...baseProfile, account_closure_status: 'requested' },
  legacyProjection,
]) {
  const expected = await read(profile);
  const list = await callHandler('list', [profile]);
  const detail = await callHandler('detail', [profile]);
  for (const result of [list.body.assemblers[0].readiness, detail.body.readiness]) {
    assert.equal(result.offerStatus, expected.offerStatus);
    assert.equal(result.requirementsReady, expected.requirementsReady);
    assert.deepEqual(result.requirementsMissingItems, expected.requirementsMissingItems);
  }
}

const connectProfile = { ...baseProfile, stripe_connect_account_id: 'acct_test' };
for (const available of [true, false]) {
  const detail = await callHandler('detail', [{ ...connectProfile, is_available: available }], { connectRequired: true });
  const readiness = detail.body.readiness;
  assert.equal(readiness.taxReadinessStatus, 'Action Required');
  assert.equal(readiness.payoutSetupComplete, false);
  assert.equal(readiness.requirementsReady, true);
  assert.equal(readiness.offerStatus, available ? 'ready' : 'offline');
  assert.equal(readiness.isReady, available);
  assert.equal(readiness.finalStatus, available ? 'READY FOR JOBS' : 'ACTION REQUIRED');
  assert.deepEqual(readiness.missingItems, available ? [] : ['Online and available']);
  assert.deepEqual(detail.calls.stripe, ['acct_test']);
  assert.equal(detail.calls.updates.length, 1, 'existing Connect cache synchronization is preserved');
  assert.deepEqual(Object.keys(detail.calls.updates[0]).sort(), [
    'stripe_connect_details_submitted', 'stripe_connect_charges_enabled',
    'stripe_connect_payouts_enabled', 'stripe_connect_onboarding_complete', 'stripe_connect_updated_at',
  ].sort());
}
const stripeFailure = await callHandler('detail', [connectProfile], { connectRequired: true, stripeError: true });
assert.equal(stripeFailure.body.readiness.offerStatus, 'ready', 'payout lookup outage cannot invent job requirements');
assert.equal(stripeFailure.body.readiness.taxReadinessStatus, 'Unknown');
assert.equal(stripeFailure.body.readiness.payoutSetupComplete, false);
assert.deepEqual(stripeFailure.calls.updates, []);

for (const kind of ['list', 'detail']) {
  const denied = await callHandler(kind, [baseProfile], { authorized: false });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.calls.db, 0);
  const wrongMethod = await callHandler(kind, [baseProfile], { method: 'POST' });
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.calls.db, 0);
  const failure = await callHandler(kind, [], { error: { message: 'Mock read failure' } });
  assert.equal(failure.statusCode, kind === 'list' ? 500 : 404);
  assert.equal(failure.body.readiness, undefined);
  assert.equal(failure.body.assemblers, undefined);
}

console.log('Easer readiness presentation: PASS (canonical evidence, availability, raw approval, actual roster/detail handlers, tax and payout separation, auth/read failures)');
