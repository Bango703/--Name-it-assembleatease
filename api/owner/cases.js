import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  availableOperationCaseActions,
  isMissingOperationCasesError,
  isOperationCaseSeverity,
  isOperationCaseStatus,
  isOperationCaseType,
  operationCaseOwnerStatusLabel,
  operationCasePublicStatus,
  operationCaseTypeLabel,
} from '../_operation-cases.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set(['open', 'acknowledged', 'in_progress', 'waiting_customer', 'waiting_easer']);
const CASE_SELECT = [
  'id', 'case_ref', 'case_type', 'source', 'source_ref', 'status', 'severity',
  'subject', 'description', 'booking_id', 'customer_name', 'customer_email',
  'customer_phone', 'easer_id', 'assigned_to', 'acknowledged_at',
  'last_public_update_at', 'resolved_at', 'closed_at', 'resolution_summary',
  'created_by_type', 'created_by_name', 'created_at', 'updated_at',
].join(', ');

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = getSupabase();
  const caseId = String(req.query?.caseId || '').trim();
  if (caseId && !UUID_RE.test(caseId)) return res.status(400).json({ error: 'A valid caseId is required' });

  if (caseId) return loadCaseDetail({ sb, res, caseId });
  return loadCaseList({ sb, res, query: req.query || {} });
}

async function loadCaseList({ sb, res, query }) {
  const statusFilter = normalize(query.status);
  const typeFilter = normalize(query.caseType);
  const severityFilter = normalize(query.severity);

  if (statusFilter && statusFilter !== 'active' && statusFilter !== 'all' && !isOperationCaseStatus(statusFilter)) {
    return res.status(400).json({ error: 'Invalid case status filter' });
  }
  if (typeFilter && typeFilter !== 'all' && !isOperationCaseType(typeFilter)) {
    return res.status(400).json({ error: 'Invalid case type filter' });
  }
  if (severityFilter && severityFilter !== 'all' && !isOperationCaseSeverity(severityFilter)) {
    return res.status(400).json({ error: 'Invalid case severity filter' });
  }

  const { data, error } = await sb
    .from('operations_cases')
    .select(CASE_SELECT)
    .order('updated_at', { ascending: false })
    .limit(500);

  if (error) return caseLoadError(res, error);

  const allCases = data || [];
  const [bookingMap, easerMap, notificationMap] = await Promise.all([
    loadBookingMap(sb, allCases),
    loadEaserMap(sb, allCases),
    loadNotificationMap(sb, allCases),
  ]);
  const filtered = allCases.filter((row) => {
    if (statusFilter === 'active' && !ACTIVE_STATUSES.has(row.status)) return false;
    if (statusFilter && statusFilter !== 'active' && statusFilter !== 'all' && row.status !== statusFilter) return false;
    if (typeFilter && typeFilter !== 'all' && row.case_type !== typeFilter) return false;
    if (severityFilter && severityFilter !== 'all' && row.severity !== severityFilter) return false;
    return true;
  });

  return res.status(200).json({
    summary: summarizeOperationCases(allCases),
    filters: { status: statusFilter || 'active', caseType: typeFilter || 'all', severity: severityFilter || 'all' },
    cases: filtered.map((row) => formatOperationCase(row, {
      booking: bookingMap.get(row.booking_id) || null,
      easer: easerMap.get(row.easer_id) || null,
      notifications: notificationMap.get(row.id) || emptyNotificationSummary(),
    })),
  });
}

async function loadCaseDetail({ sb, res, caseId }) {
  const { data: row, error } = await sb
    .from('operations_cases')
    .select(CASE_SELECT)
    .eq('id', caseId)
    .maybeSingle();

  if (error) return caseLoadError(res, error);
  if (!row) return res.status(404).json({ error: 'Case not found' });

  const [eventsResult, bookingMap, easerMap, notificationMap] = await Promise.all([
    sb.from('operations_case_events')
      .select('id, event_type, actor_type, actor_name, from_status, to_status, note, public_message, metadata, created_at')
      .eq('case_id', caseId)
      .order('created_at', { ascending: true })
      .limit(500),
    loadBookingMap(sb, [row]),
    loadEaserMap(sb, [row]),
    loadNotificationMap(sb, [row]),
  ]);

  if (eventsResult.error) return caseLoadError(res, eventsResult.error);

  return res.status(200).json({
    case: formatOperationCase(row, {
      booking: bookingMap.get(row.booking_id) || null,
      easer: easerMap.get(row.easer_id) || null,
      notifications: notificationMap.get(row.id) || emptyNotificationSummary(),
    }),
    events: (eventsResult.data || []).map(formatCaseEvent),
  });
}

async function loadBookingMap(sb, cases) {
  const ids = [...new Set(cases.map((row) => row.booking_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await sb
    .from('bookings')
    .select('id, ref, service, status, payment_status, payout_status, damage_review_status')
    .in('id', ids);
  if (error) {
    console.error('Operations case booking linkage load failed:', error);
    return new Map();
  }
  return new Map((data || []).map((row) => [row.id, {
    id: row.id,
    ref: row.ref,
    service: row.service,
    status: row.status,
    paymentStatus: row.payment_status,
    payoutStatus: row.payout_status,
    damageReviewStatus: row.damage_review_status || null,
  }]));
}

async function loadEaserMap(sb, cases) {
  const ids = [...new Set(cases.map((row) => row.easer_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await sb
    .from('profiles')
    .select('id, full_name, email, phone')
    .eq('role', 'assembler')
    .in('id', ids);
  if (error) {
    console.error('Operations case Easer linkage load failed:', error);
    return new Map();
  }
  return new Map((data || []).map((row) => [row.id, {
    id: row.id,
    name: row.full_name || null,
    email: row.email || null,
    phone: row.phone || null,
  }]));
}

async function loadNotificationMap(sb, cases) {
  const ids = cases.map((row) => row.id).filter(Boolean);
  if (!ids.length) return new Map();
  const { data, error } = await sb
    .from('notification_log')
    .select('operation_case_id, notification_type, recipient_type, status, error_text, sent_at')
    .in('operation_case_id', ids)
    .order('sent_at', { ascending: false })
    .limit(1000);
  if (error) {
    console.error('Operations case notification load failed:', error);
    return new Map();
  }

  const map = new Map();
  for (const row of data || []) {
    const summary = map.get(row.operation_case_id) || emptyNotificationSummary();
    summary.attempts += 1;
    if (['failed', 'bounced', 'complained', 'delivery_delayed'].includes(row.status)) summary.failed += 1;
    if (!summary.latest) summary.latest = {
      type: row.notification_type,
      recipientType: row.recipient_type,
      status: row.status,
      error: row.error_text || null,
      sentAt: row.sent_at,
    };
    map.set(row.operation_case_id, summary);
  }
  return map;
}

export function summarizeOperationCases(rows = []) {
  const activeRows = rows.filter((row) => ACTIVE_STATUSES.has(row.status));
  return {
    total: rows.length,
    active: activeRows.length,
    new: rows.filter((row) => row.status === 'open').length,
    critical: activeRows.filter((row) => row.severity === 'critical').length,
    highPriority: activeRows.filter((row) => row.severity === 'high' || row.severity === 'critical').length,
    waitingCustomer: rows.filter((row) => row.status === 'waiting_customer').length,
    waitingEaser: rows.filter((row) => row.status === 'waiting_easer').length,
    resolved: rows.filter((row) => row.status === 'resolved' || row.status === 'closed').length,
  };
}

export function formatOperationCase(row, context = {}) {
  const booking = context.booking || null;
  const requiresBookingDamageResolution = row.case_type === 'damage'
    && booking?.damageReviewStatus === 'review_required';
  const actions = availableOperationCaseActions(row.status).filter(action => (
    !requiresBookingDamageResolution || !['resolve', 'close'].includes(action.action)
  ));
  return {
    id: row.id,
    ref: row.case_ref,
    type: row.case_type,
    typeLabel: operationCaseTypeLabel(row.case_type),
    source: row.source,
    sourceRef: row.source_ref,
    status: row.status,
    statusLabel: operationCaseOwnerStatusLabel(row.status),
    customerStatus: operationCasePublicStatus(row.status, 'customer'),
    easerStatus: operationCasePublicStatus(row.status, 'easer'),
    severity: row.severity,
    subject: row.subject,
    description: row.description,
    booking,
    customer: {
      name: row.customer_name || null,
      email: row.customer_email || null,
      phone: row.customer_phone || null,
    },
    easerId: row.easer_id || null,
    easer: context.easer || null,
    assignedTo: row.assigned_to || null,
    createdBy: { type: row.created_by_type, name: row.created_by_name || null },
    acknowledgedAt: row.acknowledged_at || null,
    lastPublicUpdateAt: row.last_public_update_at || null,
    resolvedAt: row.resolved_at || null,
    closedAt: row.closed_at || null,
    resolutionSummary: row.resolution_summary || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notifications: context.notifications || emptyNotificationSummary(),
    availableActions: actions,
    requiresBookingDamageResolution,
  };
}

function formatCaseEvent(row) {
  return {
    id: row.id,
    type: row.event_type,
    actor: { type: row.actor_type, name: row.actor_name || null },
    fromStatus: row.from_status || null,
    toStatus: row.to_status || null,
    fromStatusLabel: row.from_status ? operationCaseOwnerStatusLabel(row.from_status) : null,
    toStatusLabel: row.to_status ? operationCaseOwnerStatusLabel(row.to_status) : null,
    note: row.note || null,
    publicMessage: row.public_message || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

function emptyNotificationSummary() {
  return { attempts: 0, failed: 0, latest: null };
}

function caseLoadError(res, error) {
  console.error('Operations case load failed:', error);
  if (isMissingOperationCasesError(error)) {
    return res.status(503).json({
      error: 'Operations Cases requires migration 053.',
      setupNeeded: true,
      requiredMigration: 53,
    });
  }
  return res.status(500).json({ error: 'Failed to load operations cases' });
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}
