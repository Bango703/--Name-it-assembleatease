import { randomUUID } from 'crypto';

export const OPERATION_CASE_TYPES = Object.freeze({
  SUPPORT: 'support',
  DAMAGE: 'damage',
  QUALITY: 'quality',
  PAYMENT: 'payment',
  DISPUTE: 'dispute',
  SAFETY: 'safety',
  LATE_ARRIVAL: 'late_arrival',
  NO_SHOW: 'no_show',
  MISSING_HARDWARE: 'missing_hardware',
  ACCOUNT: 'account',
});

export const OPERATION_CASE_STATUSES = Object.freeze({
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in_progress',
  WAITING_CUSTOMER: 'waiting_customer',
  WAITING_EASER: 'waiting_easer',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
});

export const OPERATION_CASE_SEVERITIES = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  CRITICAL: 'critical',
});

export const OPERATION_CASE_SOURCES = Object.freeze({
  CONTACT_FORM: 'contact_form',
  BOOKING: 'booking',
  CUSTOMER_REPORT: 'customer_report',
  EASER_REPORT: 'easer_report',
  STRIPE: 'stripe',
  OWNER: 'owner',
  SYSTEM: 'system',
});

const TYPE_LABELS = Object.freeze({
  support: 'Support Request',
  damage: 'Damage Report',
  quality: 'Quality Issue',
  payment: 'Payment Issue',
  dispute: 'Payment Dispute',
  safety: 'Safety Report',
  late_arrival: 'Late Arrival',
  no_show: 'No-Show',
  missing_hardware: 'Missing Hardware',
  account: 'Account Support',
});

const OWNER_STATUS_LABELS = Object.freeze({
  open: 'Open',
  acknowledged: 'Acknowledged',
  in_progress: 'In Progress',
  waiting_customer: 'Waiting for Customer',
  waiting_easer: 'Waiting for Easer',
  resolved: 'Resolved',
  closed: 'Closed',
});

// Public copy deliberately exposes only the user's outcome or required action.
// Internal teams, queues, payment checks, and operator roles never appear here.
const CUSTOMER_STATUS = Object.freeze({
  open: { code: 'received', label: 'Received', actionRequired: false },
  acknowledged: { code: 'in_progress', label: 'In Progress', actionRequired: false },
  in_progress: { code: 'in_progress', label: 'In Progress', actionRequired: false },
  waiting_customer: { code: 'action_required', label: 'Action Required', actionRequired: true },
  waiting_easer: { code: 'in_progress', label: 'In Progress', actionRequired: false },
  resolved: { code: 'resolved', label: 'Resolved', actionRequired: false },
  closed: { code: 'resolved', label: 'Resolved', actionRequired: false },
});

const EASER_STATUS = Object.freeze({
  open: { code: 'received', label: 'Received', actionRequired: false },
  acknowledged: { code: 'in_progress', label: 'In Progress', actionRequired: false },
  in_progress: { code: 'in_progress', label: 'In Progress', actionRequired: false },
  waiting_customer: { code: 'in_progress', label: 'In Progress', actionRequired: false },
  waiting_easer: { code: 'action_required', label: 'Action Required', actionRequired: true },
  resolved: { code: 'resolved', label: 'Resolved', actionRequired: false },
  closed: { code: 'resolved', label: 'Resolved', actionRequired: false },
});

const ALLOWED_TRANSITIONS = Object.freeze({
  open: Object.freeze(['acknowledged', 'in_progress', 'resolved', 'closed']),
  acknowledged: Object.freeze(['in_progress', 'waiting_customer', 'waiting_easer', 'resolved', 'closed']),
  in_progress: Object.freeze(['waiting_customer', 'waiting_easer', 'resolved', 'closed']),
  waiting_customer: Object.freeze(['in_progress', 'waiting_easer', 'resolved', 'closed']),
  waiting_easer: Object.freeze(['in_progress', 'waiting_customer', 'resolved', 'closed']),
  resolved: Object.freeze(['in_progress', 'closed']),
  closed: Object.freeze(['in_progress']),
});

const ACTION_TARGETS = Object.freeze({
  acknowledge: 'acknowledged',
  start: 'in_progress',
  wait_customer: 'waiting_customer',
  wait_easer: 'waiting_easer',
  resolve: 'resolved',
  close: 'closed',
  reopen: 'in_progress',
});

const ACTION_LABELS = Object.freeze({
  acknowledge: 'Acknowledge',
  start: 'Start Work',
  wait_customer: 'Wait for Customer',
  wait_easer: 'Wait for Easer',
  resolve: 'Resolve',
  close: 'Close',
  reopen: 'Reopen',
  add_note: 'Add Internal Note',
});

const CONFIRMATION_ACTIONS = new Set(['resolve', 'close', 'reopen']);

export function isOperationCaseType(value) {
  return Object.values(OPERATION_CASE_TYPES).includes(normalize(value));
}

export function isOperationCaseStatus(value) {
  return Object.values(OPERATION_CASE_STATUSES).includes(normalize(value));
}

export function isOperationCaseSeverity(value) {
  return Object.values(OPERATION_CASE_SEVERITIES).includes(normalize(value));
}

export function operationCaseTypeLabel(value) {
  return TYPE_LABELS[normalize(value)] || 'Operational Case';
}

export function operationCaseOwnerStatusLabel(value) {
  return OWNER_STATUS_LABELS[normalize(value)] || 'Unknown';
}

export function operationCasePublicStatus(value, audience = 'customer') {
  const map = audience === 'easer' ? EASER_STATUS : CUSTOMER_STATUS;
  return map[normalize(value)] || { code: 'in_progress', label: 'In Progress', actionRequired: false };
}

export function canTransitionOperationCase(fromStatus, toStatus) {
  return (ALLOWED_TRANSITIONS[normalize(fromStatus)] || []).includes(normalize(toStatus));
}

export function operationCaseActionTarget(action) {
  return ACTION_TARGETS[normalize(action)] || null;
}

export function operationCaseActionRequiresConfirmation(action) {
  return CONFIRMATION_ACTIONS.has(normalize(action));
}

export function availableOperationCaseActions(status) {
  const normalizedStatus = normalize(status);
  const allowedTargets = ALLOWED_TRANSITIONS[normalizedStatus] || [];
  const actions = Object.entries(ACTION_TARGETS)
    .filter(([action]) => {
      const isTerminal = normalizedStatus === 'resolved' || normalizedStatus === 'closed';
      if (action === 'reopen') return isTerminal;
      if (action === 'start') return !isTerminal;
      return true;
    })
    .filter(([, target]) => allowedTargets.includes(target))
    .map(([action, targetStatus]) => ({
      action,
      label: ACTION_LABELS[action],
      targetStatus,
      targetLabel: operationCaseOwnerStatusLabel(targetStatus),
      requiresConfirmation: operationCaseActionRequiresConfirmation(action),
    }));
  actions.push({
    action: 'add_note',
    label: ACTION_LABELS.add_note,
    targetStatus: normalizedStatus,
    targetLabel: operationCaseOwnerStatusLabel(normalizedStatus),
    requiresConfirmation: false,
  });
  return actions;
}

export function buildOperationCaseRef(prefix = 'CS') {
  const safePrefix = String(prefix || 'CS').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'CS';
  const time = Date.now().toString(36).toUpperCase();
  const entropy = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `AAE-${safePrefix}-${time}-${entropy}`;
}

export async function createOperationCase(sb, input) {
  const payload = normalizeCreateInput(input);
  const { data, error } = await sb.rpc('create_operations_case_v1', {
    p_case_ref: payload.caseRef,
    p_case_type: payload.caseType,
    p_source: payload.source,
    p_source_ref: payload.sourceRef,
    p_severity: payload.severity,
    p_subject: payload.subject,
    p_description: payload.description,
    p_booking_id: payload.bookingId,
    p_customer_name: payload.customerName,
    p_customer_email: payload.customerEmail,
    p_customer_phone: payload.customerPhone,
    p_easer_id: payload.easerId,
    p_created_by_type: payload.createdByType,
    p_created_by_name: payload.createdByName,
    p_metadata: payload.metadata,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id || !row?.case_ref) throw new Error('Operations case was not returned after creation');
  return row;
}

export async function transitionOperationCase(sb, input) {
  const { data, error } = await sb.rpc('transition_operations_case_v1', {
    p_case_id: input.caseId,
    p_expected_status: normalize(input.expectedStatus),
    p_target_status: normalize(input.targetStatus),
    p_actor_type: normalize(input.actorType || 'owner'),
    p_actor_id: input.actorId || null,
    p_actor_name: clean(input.actorName || 'Owner', 120),
    p_note: cleanMultiline(input.note, 4000) || null,
    p_public_message: cleanMultiline(input.publicMessage, 2000) || null,
    p_confirmed: input.confirmed === true,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) throw new Error('Operations case transition did not return a case');
  return row;
}

export async function appendOperationCaseEvent(sb, input) {
  const { data, error } = await sb.rpc('append_operations_case_event_v1', {
    p_case_id: input.caseId,
    p_event_type: normalize(input.eventType),
    p_actor_type: normalize(input.actorType || 'system'),
    p_actor_id: input.actorId || null,
    p_actor_name: clean(input.actorName || 'System', 120),
    p_note: cleanMultiline(input.note, 4000) || null,
    p_public_message: cleanMultiline(input.publicMessage, 2000) || null,
    p_metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export function isMissingOperationCasesError(error) {
  const message = String(error?.message || error || '');
  return error?.code === '42P01'
    || error?.code === '42883'
    || /operations_cases|operations_case_events|create_operations_case_v1|transition_operations_case_v1/i.test(message);
}

function normalizeCreateInput(input = {}) {
  const caseType = normalize(input.caseType);
  const source = normalize(input.source);
  const severity = normalize(input.severity || 'normal');
  if (!isOperationCaseType(caseType)) throw new Error('Invalid operations case type');
  if (!Object.values(OPERATION_CASE_SOURCES).includes(source)) throw new Error('Invalid operations case source');
  if (!isOperationCaseSeverity(severity)) throw new Error('Invalid operations case severity');

  const subject = clean(input.subject, 180);
  const description = cleanMultiline(input.description, 5000);
  if (!subject || !description) throw new Error('Operations case subject and description are required');

  return {
    caseRef: clean(input.caseRef, 48) || buildOperationCaseRef(caseType === 'support' ? 'CS' : 'OP'),
    caseType,
    source,
    sourceRef: clean(input.sourceRef, 160) || null,
    severity,
    subject,
    description,
    bookingId: input.bookingId || null,
    customerName: clean(input.customerName, 120) || null,
    customerEmail: clean(input.customerEmail, 254).toLowerCase() || null,
    customerPhone: clean(input.customerPhone, 40) || null,
    easerId: input.easerId || null,
    createdByType: normalize(input.createdByType || 'system'),
    createdByName: clean(input.createdByName || 'System', 120),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function clean(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || '').trim().replace(/\r\n?/g, '\n').slice(0, maxLength);
}
