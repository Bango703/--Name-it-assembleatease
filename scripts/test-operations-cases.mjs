import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OPERATION_CASE_STATUSES,
  availableOperationCaseActions,
  buildOperationCaseRef,
  canTransitionOperationCase,
  createOperationCase,
  transitionOperationCase,
  appendOperationCaseEvent,
  operationCaseActionRequiresConfirmation,
  operationCaseActionTarget,
  operationCasePublicStatus,
} from '../api/_operation-cases.js';
import {
  normalizeCaseAction,
  validateCaseAction,
} from '../api/owner/case-action.js';
import {
  formatOperationCase,
  summarizeOperationCases,
} from '../api/owner/cases.js';
import {
  normalizeContactRequest,
  validateContactRequest,
} from '../api/contact.js';

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// One explicit case workflow contract owns allowed transitions.
assert.equal(canTransitionOperationCase('open', 'acknowledged'), true);
assert.equal(canTransitionOperationCase('open', 'waiting_customer'), false);
assert.equal(canTransitionOperationCase('resolved', 'in_progress'), true);
assert.equal(canTransitionOperationCase('closed', 'open'), false);
assert.equal(operationCaseActionTarget('resolve'), OPERATION_CASE_STATUSES.RESOLVED);
assert.equal(operationCaseActionRequiresConfirmation('resolve'), true);
assert.equal(operationCaseActionRequiresConfirmation('close'), true);
assert.equal(operationCaseActionRequiresConfirmation('reopen'), true);
assert.equal(operationCaseActionRequiresConfirmation('acknowledge'), false);

const closedActions = availableOperationCaseActions('closed');
assert.deepEqual(closedActions.map((action) => action.action), ['reopen', 'add_note']);
assert.equal(closedActions[0].requiresConfirmation, true);
const openActions = availableOperationCaseActions('open');
assert.equal(openActions.some((action) => action.action === 'reopen'), false);
assert.equal(openActions.some((action) => action.action === 'start'), true);

// External audiences see only their outcome/action, never internal departments.
const forbiddenExternalTerms = /owner|admin|internal|finance|operations|stripe|verification|review queue/i;
for (const status of Object.values(OPERATION_CASE_STATUSES)) {
  for (const audience of ['customer', 'easer']) {
    const publicStatus = operationCasePublicStatus(status, audience);
    assert.match(publicStatus.label, /^(Received|In Progress|Action Required|Resolved)$/);
    assert.doesNotMatch(publicStatus.label, forbiddenExternalTerms);
  }
}

assert.match(buildOperationCaseRef('CS'), /^AAE-CS-[A-Z0-9]+-[A-Z0-9]{8}$/);

const rpcCalls = [];
const rpcMock = {
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    if (name === 'create_operations_case_v1') {
      return { data: [{ id: 'case-id', case_ref: args.p_case_ref }], error: null };
    }
    if (name === 'transition_operations_case_v1') {
      return { data: [{ id: args.p_case_id, case_ref: 'AAE-CS-TEST-12345678', status: args.p_target_status }], error: null };
    }
    return { data: [{ id: 'event-id', case_id: args.p_case_id }], error: null };
  },
};
await createOperationCase(rpcMock, {
  caseRef: 'AAE-CS-TEST-12345678',
  caseType: 'support',
  source: 'contact_form',
  sourceRef: 'request-12345678901234567890',
  severity: 'normal',
  subject: 'Test request',
  description: 'First line\nSecond line',
  customerName: 'Customer',
  customerEmail: 'CUSTOMER@EXAMPLE.COM',
  createdByType: 'customer',
  createdByName: 'Customer',
});
assert.equal(rpcCalls[0].name, 'create_operations_case_v1');
assert.equal(rpcCalls[0].args.p_description, 'First line\nSecond line');
assert.equal(rpcCalls[0].args.p_customer_email, 'customer@example.com');
await transitionOperationCase(rpcMock, {
  caseId: 'case-id', expectedStatus: 'in_progress', targetStatus: 'resolved',
  actorType: 'owner', actorName: 'Owner', note: 'Resolution\nconfirmed.', confirmed: true,
});
assert.equal(rpcCalls[1].name, 'transition_operations_case_v1');
assert.equal(rpcCalls[1].args.p_confirmed, true);
assert.equal(rpcCalls[1].args.p_note, 'Resolution\nconfirmed.');
await appendOperationCaseEvent(rpcMock, {
  caseId: 'case-id', eventType: 'internal_note', actorType: 'owner', actorName: 'Owner', note: 'Audit note',
});
assert.equal(rpcCalls[2].name, 'append_operations_case_event_v1');

const validUuid = '11111111-1111-4111-8111-111111111111';
const resolveInput = normalizeCaseAction({
  caseId: validUuid,
  expectedStatus: 'in_progress',
  action: 'resolve',
  note: 'Customer confirmed the issue is resolved.',
  confirmed: true,
});
assert.equal(validateCaseAction(resolveInput), null);
assert.match(validateCaseAction({ ...resolveInput, confirmed: false }), /Confirmation is required/);
assert.match(validateCaseAction({ ...resolveInput, note: 'short' }), /at least 10 characters/);
assert.match(validateCaseAction({ ...resolveInput, action: 'wait_customer', note: '' }), /explaining what is needed/);

const contact = normalizeContactRequest({
  name: '  Kelly   Chitesy ',
  email: ' KPOSEY@MOOG.COM ',
  subject: ' Return visit ',
  message: 'First line\r\nSecond line',
  requestId: '11111111-1111-4111-8111-111111111111',
});
assert.equal(contact.name, 'Kelly Chitesy');
assert.equal(contact.email, 'kposey@moog.com');
assert.equal(contact.message, 'First line\nSecond line');
assert.equal(contact.requestId, '11111111-1111-4111-8111-111111111111');
assert.equal(validateContactRequest(contact), null);
assert.match(validateContactRequest({ ...contact, email: 'not-an-email' }), /valid email/i);

const summary = summarizeOperationCases([
  { status: 'open', severity: 'critical' },
  { status: 'waiting_customer', severity: 'high' },
  { status: 'resolved', severity: 'normal' },
]);
assert.deepEqual(summary, {
  total: 3,
  active: 2,
  new: 1,
  critical: 1,
  highPriority: 2,
  waitingCustomer: 1,
  waitingEaser: 0,
  resolved: 1,
});

const formatted = formatOperationCase({
  id: validUuid,
  case_ref: 'AAE-CS-TEST-12345678',
  case_type: 'support',
  source: 'contact_form',
  source_ref: 'AAE-CS-TEST-12345678',
  status: 'open',
  severity: 'normal',
  subject: 'Arrival time',
  description: 'What time will the Easer arrive?',
  booking_id: null,
  customer_name: 'Customer',
  customer_email: 'customer@example.com',
  customer_phone: null,
  easer_id: null,
  assigned_to: 'owner',
  acknowledged_at: null,
  last_public_update_at: null,
  resolved_at: null,
  closed_at: null,
  resolution_summary: null,
  created_by_type: 'customer',
  created_by_name: 'Customer',
  created_at: '2026-08-01T12:00:00.000Z',
  updated_at: '2026-08-01T12:00:00.000Z',
});
assert.equal(formatted.typeLabel, 'Support Request');
assert.equal(formatted.customerStatus.label, 'Received');
assert.equal(formatted.availableActions.some((action) => action.action === 'resolve'), true);

const [migration, contactApi, contactUi, emailHelper, casesApi, caseActionApi, ownerUi, ownerCasesJs, ownerCasesCss, mobileAudit, readiness] = await Promise.all([
  source('api/migrations/053_operations_cases.sql'),
  source('api/contact.js'),
  source('contact.html'),
  source('api/_email.js'),
  source('api/owner/cases.js'),
  source('api/owner/case-action.js'),
  source('owner/index.html'),
  source('owner/assets/cases.js'),
  source('owner/assets/cases.css'),
  source('scripts/mobile-visual-audit.mjs'),
  source('api/owner/live-readiness-check.js'),
]);

// Database access and transitions fail closed and preserve a durable event trail.
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.operations_cases/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.operations_case_events/);
assert.match(migration, /ALTER TABLE public\.operations_cases ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE ALL ON TABLE public\.operations_cases FROM PUBLIC, anon, authenticated/);
assert.match(migration, /GRANT ALL ON TABLE public\.operations_cases TO service_role/);
assert.match(migration, /FOR UPDATE/);
assert.match(migration, /p_expected_status IS DISTINCT FROM v_from_status/);
assert.match(migration, /Confirmation is required to resolve or close a case/);
assert.match(migration, /operation_case_id UUID/);
assert.match(migration, /schema_state\.migration_number = 52/);
assert.match(migration, /Migration 052 must be recorded before migration 053/);
assert.match(migration, /VALUES \(53, 'operations_cases'\)/);
assert.doesNotMatch(migration, /UPDATE public\.bookings/);
assert.doesNotMatch(migration, /stripe\.(refunds|paymentIntents|transfers|payouts)/i);

// Intake is saved before notifications and never uses a raw email provider call.
assert.ok(contactApi.indexOf('await createOperationCase') < contactApi.indexOf('Promise.allSettled'));
assert.match(contactApi, /operationCaseId: operationCase\.id/);
assert.match(contactApi, /sourceRef: payload\.requestId \|\| caseRef/);
assert.match(contactApi, /caseRef = operationCase\.case_ref/);
assert.match(contactApi, /appendOperationCaseEvent/);
assert.doesNotMatch(contactApi, /api\.resend\.com/);
assert.match(emailHelper, /operation_case_id: meta\.operationCaseId \|\| null/);
assert.match(emailHelper, /delete legacyPayload\.operation_case_id/);
assert.match(contactUi, /contactSubmissionId/);
assert.match(contactUi, /requestId:contactSubmissionId/);

// Owner-only access and separate UI assets keep the monolith from growing further.
assert.match(casesApi, /verifyOwner\(req\)/);
assert.match(caseActionApi, /verifyOwner\(req\)/);
assert.match(caseActionApi, /moneyMovementCreated: false/);
assert.doesNotMatch(caseActionApi, /\.from\(['"]bookings['"]\)/);
assert.doesNotMatch(caseActionApi, /stripe\.(refunds|paymentIntents|transfers|payouts)/i);
assert.match(ownerUi, /data-view="cases"/);
assert.match(ownerUi, /id="cases-view"/);
assert.match(ownerUi, /\/owner\/assets\/cases\.js/);
assert.match(ownerUi, /\/owner\/assets\/cases\.css/);
assert.match(ownerCasesJs, /window\.OwnerCases/);
assert.match(ownerCasesJs, /This does not send money, issue a refund, change a booking, or release an Easer payout/);
assert.match(ownerCasesCss, /@media \(max-width: 520px\)/);
assert.match(ownerCasesCss, /grid-template-columns: minmax\(0, 1fr\)/);
assert.match(mobileAudit, /ownerView: 'cases'/);
assert.match(mobileAudit, /cases: '#cases-list \.cases-list-item'/);
assert.match(readiness, /REQUIRED_SCHEMA_MIGRATION = 53/);

console.log('Operations case durability, security, copy, and owner workflow tests: PASS');
