import {
  OPERATION_CASE_SEVERITIES,
  OPERATION_CASE_TYPES,
} from '../_operation-cases.js';

/**
 * THE kinds of help an Easer can ask for from a job, and what each becomes for
 * the owner. Read by api/booking/message.js (support messages) and
 * api/booking/customer-unavailable.js (the customer-not-home flow).
 */
export const EASER_SUPPORT_TYPES = Object.freeze({
  job_issue: {
    caseType: OPERATION_CASE_TYPES.SUPPORT,
    severity: OPERATION_CASE_SEVERITIES.NORMAL,
    subject: 'Easer reported a job issue',
    notificationType: 'easer_job_issue',
  },
  cannot_make: {
    caseType: OPERATION_CASE_TYPES.SUPPORT,
    severity: OPERATION_CASE_SEVERITIES.HIGH,
    subject: 'Easer requested release from an assignment',
    notificationType: 'easer_release_request',
  },
  customer_unavailable: {
    caseType: OPERATION_CASE_TYPES.SUPPORT,
    severity: OPERATION_CASE_SEVERITIES.HIGH,
    subject: 'Customer unavailable at appointment',
    notificationType: 'easer_customer_unavailable',
  },
  customer_no_show: {
    caseType: OPERATION_CASE_TYPES.SUPPORT,
    severity: OPERATION_CASE_SEVERITIES.HIGH,
    subject: 'Customer no-show reported - confirm to cancel with the no-show fee',
    notificationType: 'easer_customer_no_show',
  },
  safety_concern: {
    caseType: OPERATION_CASE_TYPES.SAFETY,
    severity: OPERATION_CASE_SEVERITIES.CRITICAL,
    subject: 'Urgent Easer safety concern',
    notificationType: 'easer_safety_concern',
  },
  other: {
    caseType: OPERATION_CASE_TYPES.SUPPORT,
    severity: OPERATION_CASE_SEVERITIES.NORMAL,
    subject: 'Easer requested job support',
    notificationType: 'easer_support_request',
  },
});

/** How long the customer is given after the Easer reports they cannot reach them. */
export const CUSTOMER_WAIT_MINUTES = 15;

/**
 * The customer-not-home state of a booking, from its activity log rows
 * (newest first). One reading for the endpoint, the job list and the app.
 */
export function customerUnavailableState(activityRows = [], nowMs = Date.now()) {
  const reported = activityRows.find(r => r.event_type === 'customer_unavailable_reported');
  const noShow = activityRows.find(r => r.event_type === 'customer_no_show_reported');
  if (!reported) return null;
  const reportedMs = Date.parse(reported.created_at);
  const waitUntilMs = reportedMs + CUSTOMER_WAIT_MINUTES * 60 * 1000;
  return {
    reportedAt: reported.created_at,
    waitUntil: new Date(waitUntilMs).toISOString(),
    canReportNoShow: !noShow && nowMs >= waitUntilMs,
    noShowReportedAt: noShow ? noShow.created_at : null,
  };
}
