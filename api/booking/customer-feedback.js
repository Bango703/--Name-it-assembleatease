import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import {
  createOperationCase,
  OPERATION_CASE_SOURCES,
  OPERATION_CASE_TYPES,
  OPERATION_CASE_SEVERITIES,
} from '../_operation-cases.js';
import { loadCrew } from './_crew.js';
import { logActivity } from './_activity.js';

const SITE = 'https://www.assembleatease.com';
export const CUSTOMER_FLAG_REASONS = Object.freeze({
  safety: 'Safety concern',
  conduct: 'Rude or abusive',
  payment: 'Asked to pay outside the app',
  access: 'Could not access the home',
  other: 'Other',
});

/**
 * POST /api/booking/customer-feedback — an Easer's private rating of the
 * customer after a completed job, and a flag for a concern (migration 110).
 * Body: { bookingId, rating?: 1-5, flagged?: boolean, flagReason?, note? }
 *
 * The customer never sees it. The owner does, on the booking; a flag emails the
 * owner, and a safety flag opens an Operations Case.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const rating = req.body?.rating == null ? null : Number(req.body.rating);
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
    return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
  }
  const flagged = req.body?.flagged === true;
  const flagReason = flagged ? String(req.body?.flagReason || '') : null;
  if (flagged && !Object.hasOwn(CUSTOMER_FLAG_REASONS, flagReason)) return res.status(400).json({ error: 'Choose what happened.' });
  if (rating === null && !flagged) return res.status(400).json({ error: 'Choose a rating or flag a concern.' });
  const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
  if (flagged && flagReason === 'other' && !note) return res.status(400).json({ error: 'Tell us what happened.' });

  const sb = getSupabase();
  const access = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const user = access.user;

  const { data: booking, error } = await sb.from('bookings')
    .select('id, ref, service, status, assembler_id, assembler_name, customer_name, customer_email, customer_phone')
    .eq('id', bookingId).maybeSingle();
  if (error) return res.status(503).json({ error: 'The job could not be loaded. Try again.' });
  if (!booking) return res.status(404).json({ error: 'Job not found' });
  let onJob = booking.assembler_id === user.id;
  if (!onJob) {
    try {
      const crew = await loadCrew(booking.id, { sb });
      onJob = (crew.get(booking.id) || []).some(row => row.easer_id === user.id);
    } catch { onJob = false; }
  }
  if (!onJob) return res.status(404).json({ error: 'Job not found' });
  if (booking.status !== BOOKING_STATUS.COMPLETED) return res.status(409).json({ error: 'Rate the customer once the job is complete.' });

  const { data: saved, error: saveError } = await sb.from('customer_feedback')
    .upsert({
      booking_id: booking.id,
      easer_id: user.id,
      rating,
      flagged,
      flag_reason: flagReason,
      note,
    }, { onConflict: 'booking_id,easer_id' })
    .select('id, rating, flagged, flag_reason, created_at')
    .single();
  if (saveError || !saved) {
    console.error('[customer-feedback] save failed:', saveError?.message);
    return res.status(503).json({ error: 'Your feedback could not be saved. Try again.' });
  }

  const { data: easerProfile } = await sb.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const easerName = easerProfile?.full_name || booking.assembler_name || 'Easer';
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: flagged ? 'customer_flagged_by_easer' : 'customer_rated_by_easer',
    actorType: 'easer',
    actorId: user.id,
    actorName: easerName,
    description: flagged
      ? `${easerName} flagged the customer: ${CUSTOMER_FLAG_REASONS[flagReason]}`
      : `${easerName} rated the customer ${rating} of 5`,
    metadata: { rating, flagged, flagReason },
  });

  if (flagged) {
    if (flagReason === 'safety') {
      await createOperationCase(sb, {
        caseType: OPERATION_CASE_TYPES.SAFETY,
        source: OPERATION_CASE_SOURCES.EASER_REPORT,
        sourceRef: `customer-flag:${booking.id}:${user.id}`,
        severity: OPERATION_CASE_SEVERITIES.HIGH,
        subject: 'Easer flagged a customer for safety',
        description: note || 'Safety concern reported after the job.',
        bookingId: booking.id,
        customerName: booking.customer_name,
        customerEmail: booking.customer_email,
        customerPhone: booking.customer_phone,
        easerId: user.id,
        createdByType: 'easer',
        createdByName: easerName,
        metadata: { flagReason, rating },
      }).catch(caseError => console.error('[customer-feedback] case not created:', caseError?.message));
    }
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
      subject: `${flagReason === 'safety' ? 'Urgent: ' : ''}Customer flagged by an Easer — ${booking.ref}`,
      html: `<p style="font-family:Arial,sans-serif">${esc(easerName)} flagged the customer on <strong>${esc(booking.ref)}</strong>: <strong>${esc(CUSTOMER_FLAG_REASONS[flagReason])}</strong>.</p>
        ${note ? `<p style="font-family:Arial,sans-serif">${esc(note)}</p>` : ''}
        <p><a href="${SITE}/owner/">Open the dashboard</a></p>`,
      meta: { bookingId: booking.id, notificationType: 'customer_flagged_by_easer', recipientType: 'owner', disableDedupe: true },
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, feedback: { rating: saved.rating, flagged: saved.flagged, flagReason: saved.flag_reason, createdAt: saved.created_at } });
}
