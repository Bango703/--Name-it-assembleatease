import { randomUUID } from 'crypto';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { safeTokenHashMatch, randomToken, sha256 } from '../_payment-security.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { appointmentTimestampMs, chicagoTodayIso, parseIsoCalendarDate } from './_appt-date.js';
import { bookingEmailMatches } from './_guest-booking-auth.js';

const MAX_RESCHEDULES = 2;
const TIME_SLOTS = [
  '7:00 AM - 9:00 AM',
  '9:00 AM - 11:00 AM',
  '11:00 AM - 1:00 PM',
  '1:00 PM - 3:00 PM',
  '3:00 PM - 5:00 PM',
];
const SATURDAY_TIME_SLOTS = TIME_SLOTS.slice(0, 3);
const SITE = 'https://www.assembleatease.com';

function normalizeSlot(value) {
  return String(value || '').trim().replace(/\s*[\-–—]\s*/g, ' - ');
}

export function validatePublishedRescheduleSlot(date, time) {
  const requestedDate = parseIsoCalendarDate(date);
  const normalizedTime = normalizeSlot(time);
  if (!requestedDate || !TIME_SLOTS.includes(normalizedTime)) {
    return { ok: false, normalizedTime, error: 'Please choose a valid appointment date and time.' };
  }
  const requestedDay = requestedDate.getUTCDay();
  if (requestedDay === 0) {
    return { ok: false, normalizedTime, error: 'Sunday appointments are not available. Please choose Monday through Saturday.' };
  }
  if (requestedDay === 6 && !SATURDAY_TIME_SLOTS.includes(normalizedTime)) {
    return { ok: false, normalizedTime, error: 'Saturday appointments are available from 7:00 AM through 1:00 PM.' };
  }
  return { ok: true, normalizedTime, error: null };
}

function deliveryFailed(result) {
  return !result?.ok;
}

function whereExact(query, column, value) {
  return value == null ? query.is(column, null) : query.eq(column, value);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { email, ref, token, date, time } = req.body || {};
  if (!email || !ref || !token || !date || !time) {
    return res.status(400).json({ error: 'Booking access token, email, reference, new date, and new time are required.' });
  }

  const requestedDate = parseIsoCalendarDate(date);
  if (!requestedDate) return res.status(400).json({ error: 'Invalid appointment date.' });

  const windowStart = parseIsoCalendarDate(chicagoTodayIso());
  const windowEnd = new Date(windowStart.getTime() + 6 * 24 * 60 * 60 * 1000);
  if (requestedDate < windowStart || requestedDate > windowEnd) {
    return res.status(400).json({ error: 'New date must be within the next 6 days. For later dates, email service@assembleatease.com.' });
  }

  const slotValidation = validatePublishedRescheduleSlot(date, time);
  if (!slotValidation.ok) return res.status(400).json({ error: slotValidation.error });
  const normalizedTime = slotValidation.normalizedTime;

  const newApptMs = appointmentTimestampMs(date, normalizedTime);
  if (newApptMs == null || newApptMs < Date.now()) {
    return res.status(400).json({ error: 'That time has already passed. Please choose a later slot.' });
  }

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings')
    .select('*')
    .eq('ref', String(ref).toUpperCase().trim())
    .maybeSingle();

  if (fetchErr) {
    console.error('Reschedule lookup error:', fetchErr);
    return res.status(500).json({ error: 'Unable to look up booking. Please try again.' });
  }
  if (!booking || !bookingEmailMatches(booking, email) || !safeTokenHashMatch(token, booking.guest_mutation_token_hash)) {
    return res.status(403).json({ error: 'This reschedule link is invalid or expired. Open the latest tracking link and try again.' });
  }

  if (![BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED].includes(booking.status)) {
    const message = [BOOKING_STATUS.EN_ROUTE, BOOKING_STATUS.ARRIVED, BOOKING_STATUS.IN_PROGRESS].includes(booking.status)
      ? 'Your Easer is already on the way or working. Please call 737-290-6129 to make changes.'
      : 'This booking can no longer be rescheduled. Please call 737-290-6129.';
    return res.status(400).json({ error: message });
  }

  if (date === booking.date && normalizedTime === normalizeSlot(booking.time)) {
    return res.status(400).json({ error: 'That is already your scheduled date and time.' });
  }

  const priorReschedules = Number(booking.reschedule_count);
  if (!Number.isInteger(priorReschedules) || priorReschedules < 0) {
    return res.status(503).json({
      error: 'Reschedule history is unavailable. Apply migration 037 before changing this appointment.',
      code: 'RESCHEDULE_TRUTH_UNAVAILABLE',
    });
  }
  if (priorReschedules >= MAX_RESCHEDULES) {
    return res.status(409).json({
      error: `This booking has already been rescheduled ${MAX_RESCHEDULES} times. Please call 737-290-6129 for further changes.`,
      code: 'RESCHEDULE_LIMIT_REACHED',
    });
  }

  const oldDate = booking.date;
  const oldTime = booking.time;
  const now = new Date().toISOString();
  const reconfirmationRequired = Boolean(booking.assembler_id);
  const assignmentToken = reconfirmationRequired ? randomUUID() : booking.assignment_token;
  const nextGuestMutationToken = randomToken(32);
  const nextGuestMutationTokenHash = sha256(nextGuestMutationToken);
  const currentDispatchAttempt = Number(booking.dispatch_attempt || 0);
  if (booking.status === BOOKING_STATUS.CONFIRMED
      && (!Number.isInteger(currentDispatchAttempt) || currentDispatchAttempt < 0)) {
    return res.status(503).json({
      error: 'Dispatch state is invalid. The owner must reconcile this booking before it can be rescheduled.',
      code: 'DISPATCH_TRUTH_UNAVAILABLE',
    });
  }
  const update = {
    date,
    time,
    rescheduled_at: now,
    reschedule_count: priorReschedules + 1,
    guest_mutation_token_hash: nextGuestMutationTokenHash,
    reminder_sent: false,
  };
  if (booking.status === BOOKING_STATUS.CONFIRMED) {
    Object.assign(update, {
      dispatch_attempt: currentDispatchAttempt + 1,
      dispatch_token: null,
      ...(!booking.assembler_id ? { dispatch_status: null } : {}),
    });
  }
  if (reconfirmationRequired) {
    Object.assign(update, {
      assembler_accepted_at: null,
      assignment_token: assignmentToken,
      assigned_at: now,
      dispatch_status: 'reconfirmation_required',
      pipeline_stage: BOOKING_STATUS.CONFIRMED,
      dispatch_paused: true,
      needs_manual_dispatch: false,
      en_route_at: null,
      checked_in_at: null,
      job_started_at: null,
    });
  }

  let rescheduleQuery = sb.from('bookings')
    .update(update)
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('reschedule_count', priorReschedules)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  for (const [column, value] of [
    ['date', oldDate],
    ['time', oldTime],
    ['payment_status', booking.payment_status],
    ['stripe_payment_intent_id', booking.stripe_payment_intent_id],
    ['stripe_deposit_intent_id', booking.stripe_deposit_intent_id],
    ['assembler_id', booking.assembler_id],
    ['assembler_accepted_at', booking.assembler_accepted_at],
    ['assigned_at', booking.assigned_at],
    ['assignment_token', booking.assignment_token],
    ['dispatch_attempt', booking.dispatch_attempt],
    ['dispatch_status', booking.dispatch_status],
    ['dispatch_paused', booking.dispatch_paused],
    ['needs_manual_dispatch', booking.needs_manual_dispatch],
    ['reminder_sent', booking.reminder_sent],
    ['guest_mutation_token_hash', booking.guest_mutation_token_hash],
  ]) {
    rescheduleQuery = whereExact(rescheduleQuery, column, value);
  }
  const { data: updatedRows, error: updateErr } = await rescheduleQuery.select('id');
  if (updateErr || !updatedRows?.length) {
    console.error('Reschedule update failed:', updateErr);
    return res.status(409).json({ error: 'Booking changed before the reschedule could be saved. Refresh and try again.' });
  }

  // Rotating dispatch_attempt in the booking CAS makes every prior offer stale
  // immediately. This cleanup is operational bookkeeping; a failure cannot make
  // an old offer acceptable again because accept_dispatch_offer checks the round.
  let dispatchOfferCleanupError = null;
  if (booking.status === BOOKING_STATUS.CONFIRMED) {
    const { error: offerCleanupError } = await sb.from('dispatch_offers')
      .update({ offer_status: 'cancelled' })
      .eq('booking_id', booking.id)
      .eq('offer_status', 'sent');
    dispatchOfferCleanupError = offerCleanupError?.message || null;
    if (offerCleanupError) console.error('Reschedule dispatch offer cleanup failed:', offerCleanupError);
  }

  const remaining = MAX_RESCHEDULES - (priorReschedules + 1);
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'rescheduled',
    actorType: 'guest',
    actorName: booking.customer_name || 'Guest customer',
    description: `Customer rescheduled from ${oldDate} ${oldTime} to ${date} ${time}. Reschedule ${priorReschedules + 1} of ${MAX_RESCHEDULES}.`,
    metadata: {
      oldDate,
      oldTime,
      newDate: date,
      newTime: time,
      rescheduleNumber: priorReschedules + 1,
      easerReconfirmationRequired: reconfirmationRequired,
      dispatchAttemptFrom: booking.dispatch_attempt ?? null,
      dispatchAttemptTo: booking.status === BOOKING_STATUS.CONFIRMED ? currentDispatchAttempt + 1 : booking.dispatch_attempt ?? null,
      dispatchOfferCleanupError,
    },
  });
  if (reconfirmationRequired) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'easer_reconfirmation_required',
      actorType: 'system',
      actorName: 'reschedule',
      description: `${booking.assembler_name || 'Assigned Easer'} must accept the rescheduled date before starting travel`,
      metadata: { assemblerId: booking.assembler_id, newDate: date, newTime: time },
    });
  }

  const notifications = [];
  if (dispatchOfferCleanupError) {
    notifications.push({
      recipient: 'dispatch',
      ok: false,
      error: 'Old offers are invalid but could not be marked cancelled. Owner review is required.',
      detail: dispatchOfferCleanupError,
    });
  }
  const nextTrackUrl = `${SITE}/track?ref=${encodeURIComponent(booking.ref)}&email=${encodeURIComponent(booking.customer_email)}&token=${encodeURIComponent(nextGuestMutationToken)}`;
  const customerResult = await sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Appointment Rescheduled — ${booking.ref}`,
    replyTo: ownerEmail(),
    html: buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'RESCHEDULED',
      statusColor: '#0369a1',
      statusBg: '#f0f9ff',
      headline: 'Your appointment has been rescheduled.',
      bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> appointment is now set for <strong>${esc(date)}</strong> at <strong>${esc(time)}</strong>.</p>
        <p style="margin:0 0 16px;font-size:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;color:#92400e">Because this booking was rescheduled, a later cancellation incurs the disclosed reschedule cancellation fee. ${remaining > 0 ? `You can reschedule ${remaining} more time if needed.` : 'This was your final self-service reschedule.'}</p>
        <p style="margin:0"><a href="${esc(nextTrackUrl)}">Open your updated secure tracking link</a></p>`,
    }),
    meta: { bookingId: booking.id, notificationType: 'reschedule_customer', recipientType: 'customer', disableDedupe: true },
  }).catch(err => ({ ok: false, error: err?.message || String(err) }));
  notifications.push({ recipient: 'customer', ...customerResult });

  // If the updated secure link was not accepted by the email provider, keep the
  // customer's current browser/link token valid so an email failure cannot lock
  // them out of cancellation or another allowed reschedule.
  let effectiveGuestMutationToken = nextGuestMutationToken;
  if (!customerResult?.ok) {
    const { data: revertedTokenRows, error: tokenRevertErr } = await sb.from('bookings')
      .update({ guest_mutation_token_hash: booking.guest_mutation_token_hash })
      .eq('id', booking.id)
      .eq('guest_mutation_token_hash', nextGuestMutationTokenHash)
      .select('id');
    if (!tokenRevertErr && revertedTokenRows?.length) effectiveGuestMutationToken = token;
  }

  const ownerResult = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase System <booking@assembleatease.com>',
    subject: `Rescheduled — ${booking.ref}`,
    replyTo: ownerEmail(),
    html: `<p>Customer rescheduled <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}).</p>
      <p><strong>Old:</strong> ${esc(oldDate)} at ${esc(oldTime)}<br/><strong>New:</strong> ${esc(date)} at ${esc(time)}</p>
      ${reconfirmationRequired ? `<p><strong>Owner action:</strong> ${esc(booking.assembler_name || 'The assigned Easer')} must accept the new schedule before travel. Confirm their response or reassign the job.</p>` : ''}
      ${dispatchOfferCleanupError ? '<p><strong>Dispatch action:</strong> Prior offers are technically invalid because the dispatch round changed, but their records could not be marked cancelled. Review dispatch before sending new offers.</p>' : ''}
      <p><a href="${SITE}/owner/">Open Live Ops</a></p>`,
    meta: { bookingId: booking.id, notificationType: 'reschedule_owner', recipientType: 'owner', disableDedupe: true },
  }).catch(err => ({ ok: false, error: err?.message || String(err) }));
  notifications.push({ recipient: 'owner', ...ownerResult });

  if (reconfirmationRequired) {
    const { data: easer } = await sb.from('profiles').select('email, full_name').eq('id', booking.assembler_id).maybeSingle();
    if (easer?.email) {
      const acceptUrl = `${SITE}/assembler/my-assignments?accept=${booking.id}&token=${encodeURIComponent(assignmentToken)}`;
      const easerResult = await sendEmail({
        to: easer.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Action required: job date changed — ${booking.ref}`,
        replyTo: ownerEmail(),
        html: `<p>Hi ${esc((easer.full_name || '').split(' ')[0] || 'there')},</p>
          <p>The customer moved booking <strong>${esc(booking.ref)}</strong> to <strong>${esc(date)}</strong> at <strong>${esc(time)}</strong>.</p>
          <p>Review and accept the new schedule before starting travel. Any prior offer or acceptance no longer authorizes travel for the old appointment.</p>
          <p><a href="${esc(acceptUrl)}">Review and accept the rescheduled job</a></p>`,
        meta: { bookingId: booking.id, notificationType: 'reschedule_easer_reconfirmation', recipientType: 'easer', recipientUserId: booking.assembler_id, disableDedupe: true },
      }).catch(err => ({ ok: false, error: err?.message || String(err) }));
      notifications.push({ recipient: 'easer', ...easerResult });
    } else {
      notifications.push({ recipient: 'easer', ok: false, error: 'Assigned Easer email is missing' });
    }
  }

  const notificationFailures = notifications.filter(deliveryFailed);
  if (notificationFailures.length) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'reschedule_notification_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `Reschedule saved, but ${notificationFailures.map(item => item.recipient).join(', ')} notification failed`,
      metadata: { failures: notificationFailures },
    });
  }
  const notificationAuditFailures = notifications.filter(item => item.logged === false);
  if (notificationAuditFailures.length) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'notification_audit_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: 'Reschedule notifications were attempted, but one or more attempt logs could not be saved',
      metadata: { failures: notificationAuditFailures.map(item => ({ recipient: item.recipient, error: item.logError || null })) },
    });
  }

  return res.status(200).json({
    success: true,
    date,
    time,
    reschedulesRemaining: Math.max(0, remaining),
    easerReconfirmationRequired: reconfirmationRequired,
    guestMutationToken: effectiveGuestMutationToken,
    notificationFailures,
    notificationAuditFailures,
  });
}
