import { createHash, randomUUID } from 'crypto';
import { appointmentTimeZone, localCalendarDate } from './booking/_appt-date.js';

const SUCCESS = new Set(['provider_accepted', 'sent', 'delivered', 'delivery_delayed']);
const ROUTINE = new Set(['reminder', 'easer_reminder', 'appointment_day_of', 'review_request', 'followup', 'easer_coaching']);
const SNAPSHOT_KEYS = ['status', 'date', 'time', 'assembler_id', 'assembler_accepted_at', 'rescheduled_at', 'payment_status', 'return_visit_required', 'return_visit_date', 'return_visit_time', 'guest_mutation_token_hash', 'customer_email', 'customer_phone', 'is_test_booking', 'arrival_nudge_count', 'arrival_nudge_sent_at', 'checked_in_at', 'service', 'customer_name', 'address', 'service_city', 'service_zip', 'assembler_name', 'return_visit_remaining_scope', 'return_visit_scheduled_at', 'financial_operation_key', 'financial_operation_type', 'financial_operation_started_at', 'financial_reconciliation_required_at', 'cancellation_reconciliation_required_at', 'stripe_dispute_id', 'stripe_dispute_status'];
const SNAPSHOT_COLUMNS = ['id', ...SNAPSHOT_KEYS, 'sms_consent_at', 'sms_opted_out_at'].join(',');
const hash = value => createHash('sha256').update(String(value)).digest('hex');

export const notificationDeliveryKey = (channel, recipientKey, logicalKey) => hash(`${channel}:${recipientKey}:${logicalKey}`);

export function isRoutineNotification(type, recipientType, override) {
  if (recipientType === 'owner') return false;
  if (override === true) return true;
  return ROUTINE.has(type) || type === 'broadcast' || /^review_request_\d+$/.test(type) || /^easer_(required_action_|tier_)/.test(type);
}

export function notificationLocalHour(now, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

// Minute scanning uses real instants, so DST changes and UTC/local midnight do
// not invent nonexistent wall-clock times. At most twelve hours for this rule.
export function routineNotBefore(now = new Date(), timeZone = 'America/Chicago') {
  let instant = new Date(now);
  for (let i = 0; i <= 24 * 60; i++) {
    const hour = notificationLocalHour(instant, timeZone);
    if (hour >= 8 && hour < 20) return instant.toISOString();
    instant = new Date(instant.getTime() + 60000);
  }
  throw new Error('Cannot resolve notification quiet hours');
}

export function notificationEventKey(booking, purpose, recipient = '') {
  return [purpose, booking.id, booking.date, booking.time, booking.rescheduled_at || '', recipient].join(':');
}

function snapshotOf(booking) {
  if (!booking) return null;
  return Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, booking[key] ?? null]));
}

async function loadBooking(sb, id) {
  if (!id) return { data: null, error: null };
  return sb.from('bookings').select(SNAPSHOT_COLUMNS).eq('id', id).maybeSingle();
}

export async function acquireNotificationLease(sb, key) {
  const token = randomUUID();
  const { data, error } = await sb.rpc('acquire_notification_lease_v1', { p_key: key, p_token: token });
  return error ? { ok: false, reason: 'Notification lock unavailable', error: error.message }
    : { ok: data === true, token, reason: data === true ? null : 'Notification already processing' };
}

export async function releaseNotificationLease(sb, key, token) {
  const { error } = await sb.rpc('release_notification_lease_v1', { p_key: key, p_token: token });
  if (error) console.error('[notification] lease release failed:', error.message);
}

/** Reserve BEFORE contacting a provider. Only a confirmed previous success may
 * return ok:true,suppressed:true; a pending/failed/uncertain send never does. */
export async function prepareNotification(sb, { channel, recipient, subject, meta = {}, payload, now = new Date() }) {
  try {
    const bookingResult = await loadBooking(sb, meta.bookingId);
    if (bookingResult.error || (meta.bookingId && !bookingResult.data)) {
      return { ok: false, error: 'Booking context could not be verified; notification not sent.' };
    }
    const booking = bookingResult.data;
    const timeZone = meta.timeZone || appointmentTimeZone(booking || {});
    const type = String(meta.notificationType || 'transactional');
    const routine = isRoutineNotification(type, meta.recipientType, meta.routine);
    if (routine && booking?.is_test_booking === true) return { ok: false, skipped: 'test_booking', error: 'Routine notifications are disabled for test bookings.' };
    let recipientSnapshot = null;
    if (meta.recipientType === 'easer' && meta.recipientUserId && /^(easer_tier_|easer_coaching|easer_onboarding_link_reissued|identity_resume_link_reissued|easer_application_received|approval)/.test(type)) {
      const { data: profile, error: profileError } = await sb.from('profiles')
        .select('status,application_status,tier,tier_grace_started_at,email,account_closure_status,identity_resume_token,identity_resume_token_expires_at')
        .eq('id', meta.recipientUserId).eq('role', 'assembler').maybeSingle();
      if (profileError || !profile) return { ok: false, error: 'Current Easer status could not be verified.' };
      recipientSnapshot = Object.fromEntries(['status', 'application_status', 'tier', 'tier_grace_started_at', 'email', 'account_closure_status'].map(key => [key, profile[key] ?? null]));
      recipientSnapshot.identityTokenHash = profile.identity_resume_token ? hash(profile.identity_resume_token) : null;
      recipientSnapshot.identityTokenExpiresAt = profile.identity_resume_token_expires_at || null;
    }
    const recipientKey = meta.recipientType === 'owner' ? `owner:${String(recipient).trim().toLowerCase()}`
      : meta.recipientType === 'customer' && booking?.customer_email ? `customer:${booking.customer_email.trim().toLowerCase()}`
      : meta.recipientUserId ? `user:${meta.recipientUserId}`
      : `${meta.recipientType || 'unknown'}:${String(recipient).trim().toLowerCase()}`;
    const fingerprint = hash(JSON.stringify([channel, recipientKey, type, meta.bookingId || '', subject, payload?.body]));
    const windowMinutes = Math.max(0, Number(meta.dedupeWindowMin ?? (routine ? 1440 : 2)) || 0);
    // Explicit events are durable; legacy callers retain a sliding dedupe
    // window (the SQL also checks the previous bucket under a recipient lock).
    const logicalKey = meta.notificationKey || `${fingerprint}:${Math.floor(now.getTime() / (Math.max(1, windowMinutes) * 60000))}`;
    const key = meta._deliveryKey || notificationDeliveryKey(channel, recipientKey, logicalKey);
    const frozenPayload = { ...payload, recipientSnapshot, meta: { ...meta, _deliveryKey: key, timeZone }, timeZone };
    const { data, error } = await sb.rpc('reserve_notification_send_v1', {
      p_key: key, p_recipient_key: recipientKey, p_fingerprint: fingerprint,
      p_log: { channel, booking_id: meta.bookingId || null, operation_case_id: meta.operationCaseId || null,
        notification_type: type, recipient_type: meta.recipientType || 'unknown', recipient_email: recipient,
        recipient_user_id: meta.recipientUserId || null, subject },
      p_payload: frozenPayload, p_snapshot: snapshotOf(booking),
      p_not_before: routine ? routineNotBefore(now, timeZone) : now.toISOString(),
      p_expires_at: meta.expiresAt || (/onboarding|identity_resume/.test(type) && recipientSnapshot?.identityTokenExpiresAt
        ? new Date(Math.min(now.getTime() + 23 * 3600000, Date.parse(recipientSnapshot.identityTokenExpiresAt))).toISOString()
        : new Date(now.getTime() + 23 * 3600000).toISOString()),
      p_routine: routine, p_dedupe_minutes: meta.notificationKey ? 0 : windowMinutes,
      p_legacy_since: meta.legacySince || null,
    });
    if (error || !data?.action) return { ok: false, error: 'Notification safety checks unavailable. Apply migration 096 before enabling this release.', detail: error?.message };
    if (data.action === 'already_sent') return { ok: true, suppressed: true, reason: 'already_sent', providerId: data.providerId, sentAt: data.sentAt, logged: true };
    if (data.action !== 'send') return { ok: false, deferred: data.action === 'deferred', skipped: data.reason, error: data.reason, nextAttemptAt: data.nextAttemptAt, logged: true };
    const claim = { id: data.id, token: data.token, key, attempt: data.attempt, payload: data.payload, snapshot: data.snapshot };
    if (recipientSnapshot && Object.keys(recipientSnapshot).some(key => (data.payload?.recipientSnapshot?.[key] ?? null) !== recipientSnapshot[key])) {
      const settled = await settleNotification(sb, claim, { status: 'cancelled', error: 'Easer status changed; stale notification cancelled.' });
      return { ok: false, skipped: 'recipient_changed', error: 'Easer status changed; stale notification cancelled.', logged: settled.ok };
    }
    if (SNAPSHOT_KEYS.some(key => (data.snapshot?.[key] ?? null) !== (booking?.[key] ?? null))) {
      const settled = await settleNotification(sb, claim, { status: 'cancelled', error: 'Booking changed; stale notification cancelled.' });
      return { ok: false, skipped: 'booking_changed', error: 'Booking changed; stale notification cancelled.', logged: settled.ok };
    }
    return { ok: true, claim };
  } catch (error) {
    console.error('[notification] reserve failed:', error?.message);
    return { ok: false, error: 'Notification safety checks could not finish; nothing was sent.' };
  }
}

export async function settleNotification(sb, claim, { status, providerId = null, error = null, retryable = false }) {
  try {
  const successful = SUCCESS.has(status);
  const retry = !successful && retryable && Number(claim.attempt) < 4;
  const patch = { status, provider_id: providerId, error_text: error,
    claim_token: null, claim_expires_at: null,
    next_attempt_at: retry ? new Date(Date.now() + [60000, 300000, 1800000][Math.min(2, Math.max(0, claim.attempt - 1))]).toISOString() : null };
  if (successful) patch.provider_accepted_at = new Date().toISOString();
  if (successful || !retry) patch.send_payload = null;
  let result = await sb.from('notification_log').update(patch).eq('id', claim.id).eq('claim_token', claim.token).select('id');
  if (result.error && successful && /provider_accepted_at/.test(result.error.message || '')) {
    delete patch.provider_accepted_at;
    result = await sb.from('notification_log').update(patch).eq('id', claim.id).eq('claim_token', claim.token).select('id');
  }
  if (result.error || !result.data?.length) {
    console.error('[notification] delivery result not recorded:', result.error?.message || 'claim changed');
    return { ok: false, error: 'Provider outcome could not be recorded; review notification delivery.' };
  }
  return { ok: true };
  } catch (failure) {
    console.error('[notification] delivery result write unavailable:', failure?.message);
    return { ok: false, error: 'Provider outcome could not be recorded; review notification delivery.' };
  }
}

export async function cancelQueuedNotification(sb, id, reason) {
  const { data: row, error: loadError } = await sb.from('notification_log').select('status').eq('id', id).maybeSingle();
  if (loadError || !row || !['deferred', 'failed', 'queued'].includes(row.status)) return { ok: false, error: loadError?.message || 'Notification state changed.' };
  // A crashed request may already have reached the provider. End its retry,
  // but keep the outcome explicitly unknown instead of asserting cancellation.
  const status = row.status === 'queued' ? 'uncertain' : 'cancelled';
  const { data, error } = await sb.from('notification_log').update({ status, error_text: reason, send_payload: null, next_attempt_at: null, claim_token: null, claim_expires_at: null })
    .eq('id', id).eq('status', row.status)
    .or(`claim_expires_at.is.null,claim_expires_at.lte.${new Date().toISOString()}`).select('id');
  return { ok: !error && Boolean(data?.length), status, error: error?.message || (!data?.length ? 'Notification claim changed.' : null) };
}

export { localCalendarDate };
