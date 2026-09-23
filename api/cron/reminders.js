import { getSupabase } from '../_supabase.js';
import { formatAppointmentDate, formatSlotShort, notificationAppointmentTimestampMs, appointmentTimeZone, localCalendarDate } from '../booking/_appt-date.js';
import { sendEmail, ownerEmail, esc, formatAddress, ensureEmailShell } from '../_email.js';
import { sendSms, smsEligibility } from '../_sms.js';
import { logCron } from './_cron-logger.js';
import { BOOKING_STATUS, isBookingPaymentReadyForDispatch } from '../_source-of-truth.js';
import { isOwnerManualLiveFlow } from '../_owner-easer.js';
import { operationalDate, operationalTime } from '../owner/_active-jobs.js';
import { guestManageUrl } from '../_payment-security.js';
import { notificationEventKey, notificationLocalHour } from '../_notification-policy.js';

const SITE = 'https://www.assembleatease.com';
const FOUR_HOURS = 4 * 3600000;
const BOOKING_SELECT = 'id, ref, service, customer_name, customer_email, customer_phone, sms_consent_at, sms_opted_out_at, date, time, address, service_city, service_zip, status, reminder_sent, assembler_id, assembler_name, assembler_accepted_at, assigned_at, created_at, rescheduled_at, is_test_booking, source, payment_status, total_price, deposit_amount, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_payment_method_id, confirmed_by, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at, cancellation_reconciliation_required_at, stripe_dispute_id, stripe_dispute_status, return_visit_required, return_visit_date, return_visit_time, return_visit_scheduled_at, return_visit_remaining_scope, guest_mutation_token_hash';

function calendarOffset(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function exact(query, key, value) {
  return value == null ? query.is(key, null) : query.eq(key, value);
}

export function reminderAppointment(booking) {
  return { ...booking, date: operationalDate(booking), time: operationalTime(booking),
    rescheduled_at: booking.return_visit_required ? booking.return_visit_scheduled_at : booking.rescheduled_at };
}

// The calendar day is the job's local day, never the server's UTC day. Routine
// reminders do not turn a late confirmation into a second immediate message.
export function reminderPurpose(booking, now = new Date(), recipientType = 'customer') {
  if (booking.is_test_booking === true) return null;
  const activeReturn = booking.return_visit_required === true;
  if (activeReturn) {
    if (![BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE, BOOKING_STATUS.ARRIVED, BOOKING_STATUS.IN_PROGRESS].includes(booking.status)) return null;
  } else if (booking.status !== BOOKING_STATUS.CONFIRMED) return null;
  const appointment = reminderAppointment(booking);
  const appointmentMs = notificationAppointmentTimestampMs(appointment);
  if (appointmentMs == null || appointmentMs <= now.getTime()) return null;
  if (recipientType === 'easer' && (!booking.assembler_id || !booking.assembler_accepted_at)) return null;
  const latestChange = Math.max(...[booking.created_at, booking.rescheduled_at, activeReturn && booking.return_visit_scheduled_at,
    recipientType === 'easer' && booking.assembler_accepted_at].map(value => Date.parse(value) || 0));
  if (now.getTime() - latestChange < FOUR_HOURS) return null;
  const timeZone = appointmentTimeZone(appointment);
  const today = localCalendarDate(now, timeZone);
  const hour = notificationLocalHour(now, timeZone);
  if (appointment.date === calendarOffset(today, 1) && hour >= 9 && hour < 20) return 'day_before';
  if (appointment.date !== today || hour < 8 || hour >= 20) return null;
  const dueAt = appointmentMs - 2 * 3600000;
  // An early appointment gets the prior-day email, not a quiet-hours SMS
  // shifted into its arrival window. Hourly scans may send up to 59m late.
  const dueHour = notificationLocalHour(new Date(dueAt), timeZone);
  return dueHour >= 8 && dueHour < 20 && now.getTime() >= dueAt && now.getTime() < dueAt + 3600000 ? 'day_of' : null;
}

function legacySince(booking, recipientType) {
  const appointment = reminderAppointment(booking);
  const priorDay = calendarOffset(appointment.date, -1);
  const dayStart = notificationAppointmentTimestampMs({ ...appointment, date: priorDay, time: '12:00 AM' });
  return new Date(Math.max(dayStart || 0, ...[booking.created_at, booking.rescheduled_at, booking.return_visit_scheduled_at,
    recipientType === 'easer' && booking.assembler_accepted_at].map(value => Date.parse(value) || 0))).toISOString();
}

function notificationMeta(booking, recipientType, recipientId, purpose, now) {
  const appointment = reminderAppointment(booking);
  const timeZone = appointmentTimeZone(appointment);
  const appointmentMs = notificationAppointmentTimestampMs(appointment);
  const expiry = purpose === 'day_before'
    ? notificationAppointmentTimestampMs({ ...appointment, date: localCalendarDate(now, timeZone), time: '8:00 PM' })
    : appointmentMs - 3600000;
  return {
    bookingId: booking.id,
    notificationType: recipientType === 'easer' ? 'easer_reminder' : 'reminder',
    recipientType,
    ...(recipientType === 'easer' ? { recipientUserId: recipientId } : {}),
    notificationKey: notificationEventKey(appointment, `appointment-${purpose}`, `${recipientType}:${recipientId}:${recipientType === 'easer' ? booking.assembler_accepted_at : ''}`),
    timeZone, routine: true, eventAt: new Date(appointmentMs).toISOString(),
    expiresAt: new Date(expiry).toISOString(), legacySince: legacySince(booking, recipientType),
  };
}

export function buildReminderEmail({ booking, recipientType = 'customer', firstName = 'there' }) {
  const appointment = reminderAppointment(booking);
  const timezone = appointmentTimeZone(appointment) === 'America/Denver' ? 'Mountain Time' : 'Central Time';
  const isEaser = recipientType === 'easer';
  const url = isEaser ? `${SITE}/assembler/my-assignments` : guestManageUrl(booking);
  const title = booking.return_visit_required ? 'Your upcoming return appointment' : isEaser ? 'Your upcoming job' : 'Your upcoming appointment';
  const detailRow = (label, value) => `<tr><td style="padding:9px 0;vertical-align:top;color:#71717a;width:110px">${label}</td><td style="padding:9px 0;vertical-align:top;font-weight:600">${esc(value)}</td></tr>`;
  return ensureEmailShell(`<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:#1a1a1a">${title}</h1>
    <p style="margin:0 0 18px">Hi ${esc(firstName)}, review the latest details for your ${booking.return_visit_required ? 'return appointment' : isEaser ? 'accepted job' : 'scheduled appointment'} below.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 22px">
      ${detailRow('Booking ref', booking.ref)}${detailRow('Service', booking.service || 'Service')}
      ${detailRow('Date', formatAppointmentDate(appointment.date))}
      ${detailRow('Arrival window', `${formatSlotShort(appointment.time)} ${timezone}`)}
      ${!isEaser && booking.address ? detailRow('Address', formatAddress(booking.address)) : ''}
      ${booking.return_visit_required && booking.return_visit_remaining_scope ? detailRow('Remaining work', booking.return_visit_remaining_scope) : ''}
    </table>
    <p style="margin:0 0 20px;text-align:center"><a href="${esc(url)}" style="display:inline-block;background:#00BFFF;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">${isEaser ? 'View job details' : 'View your booking'}</a></p>
    <p style="margin:0;font-size:14px;color:#52525b">${isEaser ? 'Tap On My Way before you leave and Arrived once you are on site. If your plans change, contact us from your dashboard.' : 'Need to change your appointment? Open your booking to review the available options and cancellation terms.'}</p>`, recipientType, `${formatAppointmentDate(appointment.date)}. Arrival window: ${formatSlotShort(appointment.time)} ${timezone}.`);
}

export function buildDayOfReminderSms(booking, recipientType) {
  const appointment = reminderAppointment(booking);
  const zone = appointmentTimeZone(appointment) === 'America/Denver' ? 'MT' : 'CT';
  const shortUrl = recipientType === 'easer' ? 'assembleatease.com/assembler/my-assignments' : 'assembleatease.com/track';
  return `AssembleAtEase: ${booking.ref} today, ${formatSlotShort(appointment.time)} ${zone}. Details: ${shortUrl}`;
}

async function currentAppointment(sb, booking) {
  const { data, error } = await sb.from('bookings').select(BOOKING_SELECT).eq('id', booking.id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  for (const key of ['status', 'date', 'time', 'rescheduled_at', 'assembler_id', 'assembler_accepted_at', 'payment_status', 'return_visit_required', 'return_visit_date', 'return_visit_time', 'return_visit_scheduled_at']) {
    if ((data[key] ?? null) !== (booking[key] ?? null)) return null;
  }
  return data;
}

/** Hourly scan. One prior-day email and one timely, consented day-of SMS.
 * Durable event keys, delivery outcomes and recipient spacing live in the
 * shared sender; reminder_sent is only a compatibility display projection. */
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  const startedAt = Date.now();
  const now = new Date();
  const sb = getSupabase();
  let sent = 0;
  let reconciled = 0;
  let deferred = 0;
  let expiringAuthsWarned = 0;
  const errors = [];
  const fromDate = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const throughDate = new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  try {
    const { data: bookings, error } = await sb.from('bookings').select(BOOKING_SELECT)
      .in('status', [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE, BOOKING_STATUS.ARRIVED, BOOKING_STATUS.IN_PROGRESS])
      .or(`and(date.gte.${fromDate},date.lte.${throughDate}),and(return_visit_required.eq.true,return_visit_date.gte.${fromDate},return_visit_date.lte.${throughDate})`)
      .order('date', { ascending: true }).limit(300);
    if (error) throw error;
    for (const candidate of bookings || []) {
      if (!reminderPurpose(candidate, now, 'customer') && !reminderPurpose(candidate, now, 'easer')) continue;
      try {
        const booking = await currentAppointment(sb, candidate);
        if (!booking) continue;
        let easer = null;
        if (booking.assembler_id) {
          const { data, error: profileError } = await sb.from('profiles')
            .select('id, role, is_owner, full_name, email, phone, sms_consent_at, sms_opted_out_at')
            .eq('id', booking.assembler_id).eq('role', 'assembler').maybeSingle();
          if (profileError) errors.push({ ref: booking.ref, error: `Easer reminder lookup failed: ${profileError.message}` });
          else easer = data;
        }
        const financialHold = booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at
          || booking.financial_reconciliation_required_at || booking.cancellation_reconciliation_required_at;
        if (financialHold || (!isBookingPaymentReadyForDispatch(booking) && !isOwnerManualLiveFlow(booking, easer || {}))) continue;

        // A customer channel failure must never prevent the Easer's independent
        // reminder. SMS consent is rechecked by the shared sender at delivery.
        for (const recipientType of ['customer', 'easer']) {
          const purpose = reminderPurpose(booking, now, recipientType);
          if (!purpose || (recipientType === 'easer' && !easer)) continue;
          const person = recipientType === 'easer' ? easer : { email: booking.customer_email, phone: booking.customer_phone, full_name: booking.customer_name, sms_consent_at: booking.sms_consent_at, sms_opted_out_at: booking.sms_opted_out_at };
          const recipientId = recipientType === 'easer' ? person.id : String(person.email || person.phone || '').trim().toLowerCase();
          const meta = notificationMeta(booking, recipientType, recipientId, purpose, now);
          let result;
          try {
            if (purpose === 'day_before') {
              if (!person.email) continue;
              result = await sendEmail({ to: person.email, from: 'AssembleAtEase <booking@assembleatease.com>',
                subject: `Reminder: Your ${booking.return_visit_required ? 'return appointment' : recipientType === 'easer' ? 'AssembleAtEase job' : 'appointment'} is tomorrow — ${booking.ref}`,
                html: buildReminderEmail({ booking, recipientType, firstName: (person.full_name || 'there').split(' ')[0] }),
                replyTo: 'service@assembleatease.com', meta });
            } else {
              if (!smsEligibility(person).ok) continue;
              result = await sendSms({ recipient: person,
                body: buildDayOfReminderSms(booking, recipientType), meta });
            }
          } catch (error) { result = { ok: false, error: error?.message || String(error) }; }
          if (!result?.ok) {
            if (result?.deferred) deferred++;
            else errors.push({ ref: booking.ref, recipientType, error: result?.error || result?.skipped || 'Reminder not sent' });
            continue;
          }
          if (result.suppressed) reconciled++; else sent++;
          if (result.logged === false) errors.push({ ref: booking.ref, error: result.logError || 'Provider accepted reminder but delivery log failed' });
          if (recipientType === 'customer' && purpose === 'day_before' && booking.reminder_sent !== true) {
            let update = sb.from('bookings').update({ reminder_sent: true }).eq('id', booking.id);
            for (const key of ['status', 'date', 'time', 'rescheduled_at', 'reminder_sent', 'return_visit_required', 'return_visit_date', 'return_visit_time', 'return_visit_scheduled_at']) update = exact(update, key, booking[key]);
            const { data: flaggedRows, error: flagError } = await update.select('id');
            if (flagError) errors.push({ ref: booking.ref, error: `Reminder accepted but display flag could not be saved: ${flagError.message}` });
            else if (!flaggedRows?.length) {
              const latest = await currentAppointment(sb, booking);
              if (latest?.reminder_sent !== true) errors.push({ ref: booking.ref, error: 'Reminder was accepted for the prior appointment; the current booking display was left unchanged.' });
            }
          }
        }
      } catch (error) { errors.push({ ref: candidate.ref, error: error?.message || String(error) }); }
    }

    // The age of our authorization record is a review trigger, not Stripe's
    // exact capture deadline. Financial execution is untouched by this cron.
    const { data: authorizations, error: authError } = await sb.from('bookings')
      .select('id, ref, service, customer_name, date, payment_authorized_at, is_test_booking')
      .eq('status', BOOKING_STATUS.CONFIRMED).eq('payment_status', 'authorized')
      .lte('payment_authorized_at', new Date(now.getTime() - 5 * 86400000).toISOString())
      .order('payment_authorized_at', { ascending: true }).limit(100);
    if (authError) errors.push({ ref: null, error: `Authorization review query failed: ${authError.message}` });
    const aged = (authorizations || []).filter(b => b.is_test_booking !== true);
    if (aged.length) {
      const rows = aged.map(b => `<li>${esc(b.ref)}: ${esc(b.service || 'Service')}, ${esc(formatAppointmentDate(b.date))}; authorized ${esc(formatAppointmentDate(String(b.payment_authorized_at).slice(0, 10)))}</li>`).join('');
      const result = await sendEmail({ to: ownerEmail(), from: 'AssembleAtEase System <booking@assembleatease.com>',
        subject: `Review needed: ${aged.length} aging card authorization(s)`,
        html: ensureEmailShell(`<h1 style="font-size:22px">Review aging card authorizations</h1><p>These bookings have authorization records at least five days old. Review each PaymentIntent in Stripe for its current status and actual capture deadline, then follow up on any job that needs action.</p><ul>${rows}</ul><p>Authorization age alone does not establish an expiry date. Do not mark a job complete or cancel it solely to move a payment.</p><p><a href="${SITE}/owner/">Open the owner dashboard</a></p>`, 'owner'),
        meta: { notificationType: 'authorization_age_review', recipientType: 'owner', notificationKey: `authorization-age-review:${localCalendarDate(now, 'America/Chicago')}`, routine: false },
      });
      if (result?.ok && !result.suppressed) expiringAuthsWarned = aged.length;
      else if (!result?.ok && !result?.deferred) errors.push({ ref: null, error: result?.error || 'Authorization review email not sent' });
    }
    await logCron('reminders', { status: errors.length ? 'error' : 'ok', records: sent + expiringAuthsWarned, errorText: errors.length ? JSON.stringify(errors).slice(0, 1000) : null, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: errors.length === 0, sent, reconciled, deferred, expiringAuthsWarned, errors });
  } catch (error) {
    await logCron('reminders', { status: 'error', records: sent, errorText: error?.message || String(error), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Reminder scan failed' });
  }
}
