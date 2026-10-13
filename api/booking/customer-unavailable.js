import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendSms } from '../_sms.js';
import { guestManageUrl } from '../_payment-security.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { createOperationCase, OPERATION_CASE_SOURCES } from '../_operation-cases.js';
import { logActivity } from './_activity.js';
import { EASER_SUPPORT_TYPES, CUSTOMER_WAIT_MINUTES, customerUnavailableState } from './_easer-support.js';

const SITE = 'https://www.assembleatease.com';
const SUPPORT_PHONE_DISPLAY = '979-232-5139';

/**
 * POST /api/booking/customer-unavailable — the Easer is at the home and cannot
 * reach the customer (the DoorDash "customer unavailable" pattern).
 *
 *   { bookingId, action: 'start', note? }   tell the customer, start the wait
 *   { bookingId, action: 'no_show', note? } after the wait, report a no-show
 *
 * Nothing about money happens here. The owner confirms a no-show by cancelling
 * the booking with the No-show reason (api/booking/cancel.js), which applies the
 * cancellation policy and the Easer's share. The wait starts from the activity
 * log row this writes, so the job list and the app read the same clock.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { bookingId, action, note: rawNote } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!['start', 'no_show'].includes(action)) return res.status(400).json({ error: 'action must be start or no_show' });
  const note = String(rawNote || '').trim().slice(0, 1200);

  const sb = getSupabase();
  const access = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const user = access.user;

  const { data: booking, error: bookingError } = await sb.from('bookings')
    .select('id, ref, service, status, date, time, assembler_id, assembler_name, assembler_accepted_at, customer_name, customer_email, customer_phone, sms_consent_at, sms_opted_out_at, guest_mutation_token_hash')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingError) return res.status(503).json({ error: 'The job could not be loaded. Try again.' });
  if (!booking || booking.assembler_id !== user.id || !booking.assembler_accepted_at) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (booking.status !== BOOKING_STATUS.ARRIVED) {
    return res.status(409).json({ error: "Tap I've arrived first.", code: 'NOT_ARRIVED' });
  }

  const loadHistory = () => sb.from('activity_logs')
    .select('event_type, created_at')
    .eq('booking_id', booking.id)
    .in('event_type', ['customer_unavailable_reported', 'customer_no_show_reported'])
    .order('created_at', { ascending: false })
    .limit(10);
  const { data: history, error: historyError } = await loadHistory();
  if (historyError) return res.status(503).json({ error: 'The job could not be loaded. Try again.' });
  const state = customerUnavailableState(history || []);
  const easerName = booking.assembler_name || 'Easer';
  const firstName = String(easerName).trim().split(/\s+/)[0] || 'Your pro';

  if (action === 'start') {
    // Asking twice keeps the first clock.
    if (state) return res.status(200).json({ ok: true, ...state });

    const startedAt = new Date().toISOString();
    const logged = await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'customer_unavailable_reported',
      actorType: 'easer',
      actorId: user.id,
      actorName: easerName,
      description: `${easerName} is at the home and cannot reach the customer. The customer has ${CUSTOMER_WAIT_MINUTES} minutes.`,
      metadata: { note: note || null },
    });
    if (!logged.ok) return res.status(503).json({ error: 'That could not be saved. Try again.' });

    const caseResult = await openCase(sb, 'customer_unavailable', booking, user.id, easerName,
      `${easerName} is at the home and cannot reach the customer.${note ? `\n${note}` : ''}`);

    const bookingPage = guestManageUrl(booking, SITE) + '#bookingCommunication';
    const [sms, email] = await Promise.all([
      sendSms({
        recipient: { phone: booking.customer_phone, sms_consent_at: booking.sms_consent_at, sms_opted_out_at: booking.sms_opted_out_at },
        body: `AssembleAtEase: ${firstName} is at your home for job ${booking.ref} and can't reach you. Reply on your booking page or call ${SUPPORT_PHONE_DISPLAY} within ${CUSTOMER_WAIT_MINUTES} minutes.`,
        meta: { bookingId: booking.id, notificationType: 'customer_unavailable_notice', recipientType: 'customer' },
      }).catch(error => ({ ok: false, error: error?.message || String(error) })),
      booking.customer_email ? sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Your pro is at your home — ${booking.ref}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
          <p style="font-size:18px;font-weight:700;margin:0 0 10px">${esc(firstName)} is at your home and can't reach you</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px">Your ${esc(booking.service || 'job')} (${esc(booking.ref)}) is waiting to start. Reply on your booking page or call ${SUPPORT_PHONE_DISPLAY} within ${CUSTOMER_WAIT_MINUTES} minutes.</p>
          <p style="margin:0"><a href="${esc(bookingPage)}" style="display:inline-block;background:#00BFFF;color:#0d1117;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px">Reply to ${esc(firstName)}</a></p>
        </div>`,
        replyTo: ownerEmail(),
        meta: { bookingId: booking.id, notificationType: 'customer_unavailable_notice', recipientType: 'customer', disableDedupe: true },
      }).catch(error => ({ ok: false, error: error?.message || String(error) })) : Promise.resolve({ ok: false, skipped: 'no_email' }),
    ]);

    // The clock the Easer sees is the stored one, so the no-show check agrees with it.
    const { data: stored } = await loadHistory();
    const fresh = customerUnavailableState(stored?.length ? stored : [{ event_type: 'customer_unavailable_reported', created_at: startedAt }]);
    return res.status(200).json({
      ok: true,
      ...fresh,
      customerNotified: sms?.ok === true || email?.ok === true,
      caseRef: caseResult?.case_ref || null,
    });
  }

  // ── no_show ──────────────────────────────────────────────────────────────
  if (!state) return res.status(409).json({ error: "Tap Customer isn't here first.", code: 'NOT_REPORTED' });
  if (state.noShowReportedAt) return res.status(200).json({ ok: true, ...state });
  if (!state.canReportNoShow) {
    const minutesLeft = Math.max(1, Math.ceil((Date.parse(state.waitUntil) - Date.now()) / 60000));
    return res.status(409).json({ error: `Wait ${minutesLeft} more minute${minutesLeft === 1 ? '' : 's'} for the customer.`, code: 'STILL_WAITING', ...state });
  }

  const logged = await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'customer_no_show_reported',
    actorType: 'easer',
    actorId: user.id,
    actorName: easerName,
    description: `${easerName} reported a customer no-show after waiting ${CUSTOMER_WAIT_MINUTES} minutes. Confirm by cancelling with the No-show reason.`,
    metadata: { note: note || null, waitStartedAt: state.reportedAt },
  });
  if (!logged.ok) return res.status(503).json({ error: 'That could not be saved. Try again.' });

  const caseResult = await openCase(sb, 'customer_no_show', booking, user.id, easerName,
    `${easerName} waited ${CUSTOMER_WAIT_MINUTES} minutes from ${state.reportedAt} and could not reach the customer.${note ? `\n${note}` : ''}\nConfirm by cancelling the booking with the No-show reason.`);

  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
    subject: `Customer no-show reported — ${booking.ref}`,
    html: `<p style="font-family:Arial,sans-serif">${esc(easerName)} reported a customer no-show on <strong>${esc(booking.ref)}</strong> after waiting ${CUSTOMER_WAIT_MINUTES} minutes.</p>
      <p style="font-family:Arial,sans-serif">To confirm, cancel the booking with the <strong>No-show</strong> reason. That applies the cancellation policy and pays ${esc(firstName)} their share.</p>
      ${note ? `<p style="font-family:Arial,sans-serif"><strong>Note:</strong> ${esc(note)}</p>` : ''}
      <p><a href="${SITE}/owner/">Open the dashboard</a></p>`,
    meta: { bookingId: booking.id, notificationType: 'easer_customer_no_show', recipientType: 'owner', disableDedupe: true },
  }).catch(() => {});

  const after = customerUnavailableState([
    { event_type: 'customer_no_show_reported', created_at: new Date().toISOString() },
    ...(history || []),
  ]);
  return res.status(200).json({ ok: true, ...after, caseRef: caseResult?.case_ref || null });
}

async function openCase(sb, type, booking, easerId, easerName, description) {
  const definition = EASER_SUPPORT_TYPES[type];
  try {
    return await createOperationCase(sb, {
      caseType: definition.caseType,
      source: OPERATION_CASE_SOURCES.EASER_REPORT,
      sourceRef: `easer-${type}:${booking.id}`,
      severity: definition.severity,
      subject: definition.subject,
      description,
      bookingId: booking.id,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      customerPhone: booking.customer_phone,
      easerId,
      createdByType: 'easer',
      createdByName: easerName,
      metadata: { supportType: type, bookingRef: booking.ref || null, appointmentDate: booking.date || null, appointmentTime: booking.time || null },
    });
  } catch (error) {
    console.error(`[customer-unavailable] ${type} case not created:`, error?.message || error);
    return null;
  }
}
