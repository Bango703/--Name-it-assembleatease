import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendSms } from '../_sms.js';
import { safeTokenHashMatch, guestManageUrl } from '../_payment-security.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { appointmentTimestampMs, formatAppointmentDate, formatAppointmentDateShort, formatSlotShort } from './_appt-date.js';
import { validateBookingWindowDate, BOOKING_WINDOW_DAYS } from './_booking-window.js';
import { bookingEmailMatches } from './_guest-booking-auth.js';
import { logActivity } from './_activity.js';
import { TIME_SLOTS, validatePublishedRescheduleSlot, reschedulePaymentConflict } from './reschedule.js';
import { loadOpenProposal, PROPOSAL_STATUS } from './_time-proposals.js';

const SITE = 'https://www.assembleatease.com';

/**
 * /api/booking/time-proposal — an assigned Easer proposes a new appointment time.
 *
 * Easer (Bearer):
 *   GET  ?bookingId                              slots, the open proposal, whether one can be sent
 *   POST { bookingId, action:'propose', date, time, note? }
 *   POST { bookingId, action:'withdraw' }
 * Customer (booking link):
 *   POST { action:'decline', ref, email, token, proposalId }
 *
 * The customer accepts on their booking page through api/booking/reschedule.js
 * with the proposalId, so every reschedule rule applies and that Easer keeps the job.
 * A proposal is checked against those same rules before it is sent.
 */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  const sb = getSupabase();

  if (req.method === 'POST' && req.body?.action === 'decline') return customerDecline(req, res, sb);

  const bookingId = req.method === 'GET' ? req.query?.bookingId : req.body?.bookingId;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  const access = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const user = access.user;

  const { data: booking, error } = await sb.from('bookings')
    .select('id, ref, service, status, date, time, payment_status, assembler_id, assembler_name, assembler_accepted_at, customer_name, customer_email, customer_phone, sms_consent_at, sms_opted_out_at, guest_mutation_token_hash')
    .eq('id', bookingId).maybeSingle();
  if (error) return res.status(503).json({ error: 'The job could not be loaded. Try again.' });
  if (!booking || booking.assembler_id !== user.id || !booking.assembler_accepted_at) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const open = await loadOpenProposal(sb, booking.id);
  const blocked = proposalBlocked(booking);

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      slots: TIME_SLOTS,
      windowDays: BOOKING_WINDOW_DAYS,
      canPropose: !blocked && !open,
      reason: blocked || (open ? 'Your proposed time is waiting on the customer.' : null),
      proposal: open && open.easer_id === user.id ? { id: open.id, date: open.proposed_date, time: open.proposed_time, note: open.note || null } : null,
    });
  }

  const action = req.body?.action;
  if (action === 'withdraw') {
    if (!open || open.easer_id !== user.id) return res.status(404).json({ error: 'There is no proposed time to withdraw.' });
    const { error: withdrawError } = await sb.from('easer_time_proposals')
      .update({ status: PROPOSAL_STATUS.WITHDRAWN, responded_at: new Date().toISOString() })
      .eq('id', open.id).eq('status', PROPOSAL_STATUS.PENDING);
    if (withdrawError) return res.status(503).json({ error: 'That could not be saved. Try again.' });
    await logActivity(sb, { bookingId: booking.id, eventType: 'easer_time_proposal_withdrawn', actorType: 'easer', actorId: user.id, actorName: booking.assembler_name || 'Easer', description: 'The Easer withdrew their proposed time' });
    return res.status(200).json({ ok: true });
  }
  if (action !== 'propose') return res.status(400).json({ error: 'action must be propose, withdraw or decline' });

  if (blocked) return res.status(409).json({ error: blocked });
  if (open) return res.status(409).json({ error: 'Your proposed time is waiting on the customer.' });

  const date = String(req.body?.date || '').trim();
  const slot = validatePublishedRescheduleSlot(date, req.body?.time);
  if (!slot.ok) return res.status(400).json({ error: 'Choose a date and one of the time windows.' });
  if (!validateBookingWindowDate(date).ok) return res.status(400).json({ error: `Choose a date within the next ${BOOKING_WINDOW_DAYS} days.` });
  const startMs = appointmentTimestampMs(date, slot.normalizedTime);
  if (startMs == null || startMs <= Date.now()) return res.status(400).json({ error: 'Choose a time that has not passed.' });
  if (date === booking.date && slot.normalizedTime === String(booking.time || '').trim().replace(/\s*[-–—]\s*/g, ' - ')) {
    return res.status(400).json({ error: 'That is the time already booked.' });
  }
  if (reschedulePaymentConflict(booking, date)) {
    return res.status(409).json({ error: 'That date needs AssembleAtEase to move the payment. Use Get help on this job.', code: 'PAYMENT_RESCHEDULE_ASSISTANCE_REQUIRED' });
  }
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;

  const { data: created, error: insertError } = await sb.from('easer_time_proposals').insert({
    booking_id: booking.id,
    easer_id: user.id,
    proposed_date: date,
    proposed_time: slot.normalizedTime,
    note,
    status: PROPOSAL_STATUS.PENDING,
  }).select('id').single();
  if (insertError || !created) {
    console.error('[time-proposal] insert failed:', insertError?.message);
    return res.status(503).json({ error: 'Proposing a new time is unavailable right now. Use Get help on this job.' });
  }

  const firstName = String(booking.assembler_name || '').trim().split(/\s+/)[0] || 'Your pro';
  const when = `${formatAppointmentDateShort(date)}, ${formatSlotShort(slot.normalizedTime)}`;
  const page = guestManageUrl(booking, SITE);
  await logActivity(sb, {
    bookingId: booking.id, eventType: 'easer_time_proposed', actorType: 'easer', actorId: user.id,
    actorName: booking.assembler_name || 'Easer',
    description: `${booking.assembler_name || 'The Easer'} proposed ${date} ${slot.normalizedTime}`,
    metadata: { proposalId: created.id, date, time: slot.normalizedTime, note },
  });
  const [sms, email] = await Promise.all([
    sendSms({
      recipient: { phone: booking.customer_phone, sms_consent_at: booking.sms_consent_at, sms_opted_out_at: booking.sms_opted_out_at },
      body: `AssembleAtEase: ${firstName} proposed a new time for job ${booking.ref}: ${when}. Accept or keep your time on your booking page.`,
      meta: { bookingId: booking.id, notificationType: 'easer_time_proposal', recipientType: 'customer' },
    }).catch(e => ({ ok: false, error: e?.message })),
    booking.customer_email ? sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `New time proposed — ${booking.ref}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
        <p style="font-size:18px;font-weight:700;margin:0 0 10px">${esc(firstName)} proposed a new time</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 6px">Booked: ${esc(formatAppointmentDate(booking.date))} at ${esc(booking.time || '')}</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 16px"><strong>Proposed: ${esc(formatAppointmentDate(date))} at ${esc(slot.normalizedTime)}</strong></p>
        ${note ? `<p style="font-size:14px;color:#52525b;margin:0 0 16px">${esc(note)}</p>` : ''}
        <p style="margin:0"><a href="${esc(page)}" style="display:inline-block;background:#00BFFF;color:#0d1117;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px">Review the new time</a></p>
      </div>`,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'easer_time_proposal', recipientType: 'customer', disableDedupe: true },
    }).catch(e => ({ ok: false, error: e?.message })) : Promise.resolve({ ok: false }),
  ]);
  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
    subject: `Easer proposed a new time — ${booking.ref}`,
    html: `<p style="font-family:Arial,sans-serif">${esc(booking.assembler_name || 'The Easer')} proposed ${esc(formatAppointmentDate(date))} at ${esc(slot.normalizedTime)} for <strong>${esc(booking.ref)}</strong> (booked ${esc(booking.date || '')} ${esc(booking.time || '')}). The customer accepts or declines on their booking page.</p>`,
    meta: { bookingId: booking.id, notificationType: 'easer_time_proposal_owner', recipientType: 'owner', disableDedupe: true },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    proposal: { id: created.id, date, time: slot.normalizedTime, note },
    customerNotified: sms?.ok === true || email?.ok === true,
  });
}

/**
 * Why this job's time cannot be moved by the Easer, or null. A pro's proposal
 * does not count toward the customer's reschedule limit (api/booking/reschedule.js).
 */
function proposalBlocked(booking) {
  if (booking.status !== BOOKING_STATUS.CONFIRMED) return 'The time can only change before you start travel.';
  return null;
}

async function customerDecline(req, res, sb) {
  const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await rateLimit(ip, 'booking'))) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  const { ref, email, token, proposalId } = req.body || {};
  if (!ref || !email || !token || !proposalId) return res.status(400).json({ error: 'Open the latest link to your booking and try again.' });
  const { data: booking } = await sb.from('bookings')
    .select('id, ref, customer_email, guest_mutation_token_hash, assembler_id, assembler_name')
    .eq('ref', String(ref).trim().toUpperCase()).maybeSingle();
  if (!booking || !bookingEmailMatches(booking, email) || !safeTokenHashMatch(token, booking.guest_mutation_token_hash)) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  const open = await loadOpenProposal(sb, booking.id);
  if (!open || open.id !== proposalId) return res.status(404).json({ error: 'That proposed time is no longer open.' });
  const { error } = await sb.from('easer_time_proposals')
    .update({ status: PROPOSAL_STATUS.DECLINED, responded_at: new Date().toISOString() })
    .eq('id', open.id).eq('status', PROPOSAL_STATUS.PENDING);
  if (error) return res.status(503).json({ error: 'That could not be saved. Try again.' });
  await logActivity(sb, { bookingId: booking.id, eventType: 'easer_time_proposal_declined', actorType: 'guest', actorName: 'Customer', description: 'The customer kept the booked time and declined the proposed one' });
  const { data: easer } = await sb.from('profiles').select('email, full_name').eq('id', open.easer_id).maybeSingle();
  if (easer?.email) {
    await sendEmail({
      to: easer.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer kept the booked time — ${booking.ref}`,
      html: `<p>Hi ${esc((easer.full_name || '').split(' ')[0] || 'there')},</p><p>The customer kept the booked time for <strong>${esc(booking.ref)}</strong>. If you cannot make it, open the job and use I can't make this job.</p>`,
      meta: { bookingId: booking.id, notificationType: 'easer_time_proposal_declined', recipientType: 'easer', recipientUserId: open.easer_id, disableDedupe: true },
    }).catch(() => {});
  }
  return res.status(200).json({ ok: true });
}
