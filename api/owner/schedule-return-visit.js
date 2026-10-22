import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, buildStatusEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { chicagoTodayIso, formatAppointmentDate } from '../booking/_appt-date.js';
import { evaluateAuthorizationWindow, AUTHORIZATION_WINDOW } from '../booking/_authorization-window.js';
import { sendPushToUser } from '../_push.js';

// Which bookings can be continued on another day, and on what payment terms.
//   owner-created, paid offline: as before, no card involved.
//   card booking: the card must be held (authorized) and that hold must still
//   be good when the return visit ends. The re-hold cron only renews bookings
//   that have not started, so a job already under way cannot outlive its hold;
//   the date is refused instead of letting the payment expire unseen.
export function returnVisitPaymentLane(booking = {}) {
  if (booking.source === 'owner_manual' && booking.payment_status === 'offline_recorded') return 'offline';
  if (booking.source !== 'owner_manual' && booking.payment_status === 'authorized') return 'card_hold';
  return null;
}

const holdDeadlineText = ms => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function cleanLine(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const {
    bookingId,
    date,
    time,
    completedScope,
    remainingScope,
    notifyCustomer = true,
  } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const returnDate = cleanLine(date, 10);
  const returnTime = cleanLine(time, 40);
  const completed = cleanLine(completedScope, 1000);
  const remaining = cleanLine(remainingScope, 1000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) {
    return res.status(400).json({ error: 'Enter the return date as YYYY-MM-DD.' });
  }
  if (returnDate < chicagoTodayIso(new Date())) {
    return res.status(400).json({ error: 'The return visit cannot be scheduled in the past.' });
  }
  if (!returnTime) return res.status(400).json({ error: 'Enter the return appointment time.' });
  if (completed.length < 5 || remaining.length < 5) {
    return res.status(400).json({
      error: 'Document both the work completed and the work remaining.',
      code: 'RETURN_VISIT_SCOPE_REQUIRED',
    });
  }

  const sb = getSupabase();
  const { data: booking, error: fetchError } = await sb
    .from('bookings')
    .select('id, ref, source, status, payment_status, customer_name, customer_email, service, assembler_id, assembler_name, date, time, authorization_capture_before, return_visit_required, return_visit_date, return_visit_time, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at')
    .eq('id', bookingId)
    .single();
  if (fetchError || !booking) return res.status(404).json({ error: 'Booking not found' });

  const lane = returnVisitPaymentLane(booking);
  if (!lane) {
    return res.status(409).json({
      error: "A return visit needs the customer's card to be held for this job. This booking's payment is not held.",
      code: 'RETURN_VISIT_PAYMENT_NOT_HELD',
    });
  }
  if (lane === 'card_hold') {
    const verdict = evaluateAuthorizationWindow({
      ...booking,
      return_visit_required: true,
      return_visit_date: returnDate,
      return_visit_time: returnTime,
    });
    if (!verdict.ok) {
      const byDeadline = verdict.deadline != null && verdict.reason === AUTHORIZATION_WINDOW.EXPIRES_BEFORE_COMPLETION;
      return res.status(409).json({
        error: byDeadline
          ? `The customer's card hold ends ${holdDeadlineText(verdict.deadline)}. Pick a return date that finishes before then.`
          : verdict.reason === AUTHORIZATION_WINDOW.APPOINTMENT_UNREADABLE
            ? 'The return time could not be read. Enter it like 9:00 AM - 11:00 AM.'
            : "The customer's card hold could not be confirmed for that date, so the return visit was not saved.",
        code: byDeadline ? 'RETURN_VISIT_AFTER_CARD_HOLD' : 'RETURN_VISIT_HOLD_UNVERIFIED',
        holdEndsAt: verdict.deadline != null ? new Date(verdict.deadline).toISOString() : null,
        reason: verdict.reason,
      });
    }
  }
  if (!['confirmed', 'en_route', 'arrived', 'in_progress'].includes(booking.status)) {
    return res.status(409).json({
      error: `A return visit cannot be scheduled from booking status ${booking.status}.`,
      code: 'RETURN_VISIT_BOOKING_STATE_INVALID',
    });
  }
  if (booking.financial_operation_key
      || booking.financial_operation_type
      || booking.financial_operation_started_at
      || booking.financial_reconciliation_required_at) {
    return res.status(409).json({
      error: 'Resolve the current financial operation before scheduling the return visit.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  const now = new Date().toISOString();
  let update = sb.from('bookings').update({
    return_visit_required: true,
    return_visit_date: returnDate,
    return_visit_time: returnTime,
    return_visit_completed_scope: completed,
    return_visit_remaining_scope: remaining,
    return_visit_scheduled_at: now,
    return_visit_scheduled_by: 'owner',
    return_visit_completed_at: null,
  })
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('source', booking.source)
    .eq('payment_status', booking.payment_status)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null);
  update = booking.return_visit_required
    ? update.eq('return_visit_required', true)
    : update.eq('return_visit_required', false);

  const { data: updatedRows, error: updateError } = await update.select('id');
  if (updateError) {
    console.error('Schedule return visit update failed:', updateError);
    const migrationMissing = /return_visit_/i.test(String(updateError.message || ''));
    return res.status(migrationMissing ? 503 : 409).json({
      error: migrationMissing
        ? 'Return-visit storage is unavailable. Apply migration 044 and retry.'
        : 'The booking changed before the return visit could be saved. Refresh and retry.',
      code: migrationMissing ? 'MIGRATION_044_REQUIRED' : 'RETURN_VISIT_CONFLICT',
    });
  }
  if (!updatedRows?.length) {
    return res.status(409).json({
      error: 'The booking changed before the return visit could be saved. Refresh and retry.',
      code: 'RETURN_VISIT_CONFLICT',
    });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'return_visit_scheduled',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Return visit scheduled for ${returnDate}${returnTime ? ` at ${returnTime}` : ''}. Completed: ${completed}. Remaining: ${remaining}.`,
    metadata: {
      priorReturnDate: booking.return_visit_date || null,
      priorReturnTime: booking.return_visit_time || null,
      returnDate,
      returnTime,
      completedScope: completed,
      remainingScope: remaining,
    },
  });

  let notificationDelivered = null;
  let notificationError = null;
  if (notifyCustomer !== false && booking.customer_email) {
    try {
      const result = await sendEmail({
        to: booking.customer_email,
        subject: `Return appointment confirmed — ${booking.ref}`,
        html: buildStatusEmail({
          customerName: booking.customer_name,
          ref: booking.ref,
          status: 'RETURN VISIT',
          statusColor: '#1d4ed8',
          statusBg: '#dbeafe',
          headline: 'Your return appointment is confirmed',
          bodyHtml: `<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.7">We completed <strong>${esc(completed)}</strong>.</p>
            <p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.7">We will return on <strong>${esc(formatAppointmentDate(returnDate))}${returnTime ? ` at ${esc(returnTime)}` : ''}</strong> to complete <strong>${esc(remaining)}</strong>.</p>
            <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply here or call <a href="tel:+19792325139">(979) 232-5139</a>.</p>`,
        }),
        replyTo: ownerEmail(),
        meta: {
          bookingId: booking.id,
          notificationType: 'return_visit_customer',
          recipientType: 'customer',
          disableDedupe: true,
        },
      });
      notificationDelivered = result?.ok === true && !result?.suppressed;
      notificationError = notificationDelivered ? null : result?.error || result?.reason || 'Delivery failed';
    } catch (error) {
      notificationDelivered = false;
      notificationError = error?.message || String(error);
    }
  }

  if (notificationDelivered === false) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'return_visit_notification_failed',
      actorType: 'system',
      actorName: 'Notifications',
      description: 'Return visit was saved, but the customer notification failed. Owner follow-up is required.',
      metadata: { error: notificationError },
    });
  }

  // The assigned Easer sees the new date on the job; the app notification
  // makes sure they hear about it.
  let easerNotified = null;
  if (booking.assembler_id) {
    const push = await sendPushToUser(booking.assembler_id, {
      title: 'Return visit scheduled',
      body: `${booking.ref}: back on ${formatAppointmentDate(returnDate)} at ${returnTime}. Remaining: ${remaining.slice(0, 80)}`,
      url: `https://www.assembleatease.com/assembler/my-assignments?job=${encodeURIComponent(booking.id)}`,
      jobId: booking.id,
    }, { bookingId: booking.id, notificationType: 'return_visit_easer', recipientType: 'easer' })
      .catch(err => ({ ok: false, error: err?.message || String(err) }));
    easerNotified = push?.ok === true;
  }

  return res.status(notificationDelivered === false ? 202 : 200).json({
    ok: true,
    bookingId: booking.id,
    ref: booking.ref,
    returnVisit: {
      date: returnDate,
      time: returnTime,
      completedScope: completed,
      remainingScope: remaining,
    },
    notificationDelivered,
    notificationError,
    easerNotified,
    paymentLane: lane,
    warnings: notificationDelivered === false ? ['customer_notification_failed'] : [],
  });
}
