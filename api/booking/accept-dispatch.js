import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from './_activity.js';

const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/booking/accept-dispatch
 * Easer accepts a dispatched job offer.
 * Supports: dispatch_offers table (new) and legacy inline tokens (backwards compat).
 * Body: { bookingId, token, assemblerId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId, token, assemblerId } = req.body;
  if (!bookingId || !token || !assemblerId) {
    return res.status(400).json({ error: 'bookingId, token, and assemblerId are required' });
  }

  const sb = getSupabase();
  const now = new Date().toISOString();

  // ── Path 1: dispatch_offers table (new) ───────────────────────────────────
  const { data: offer } = await sb
    .from('dispatch_offers')
    .select('*')
    .eq('token', token)
    .eq('easer_id', assemblerId)
    .eq('offer_status', 'sent')
    .maybeSingle();

  if (offer) {
    // Verify offer not expired
    if (new Date(offer.expires_at) < new Date()) {
      await sb.from('dispatch_offers')
        .update({ offer_status: 'expired', timed_out_at: now })
        .eq('id', offer.id);
      return res.status(410).json({ error: 'Sorry — this job offer has expired. Check your dashboard for new opportunities.' });
    }

    // Verify booking still exists and is available
    const { data: booking } = await sb.from('bookings').select('*').eq('id', bookingId).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'confirmed') return res.status(400).json({ error: 'This booking is no longer available' });
    if (booking.assembler_id) return res.status(409).json({ error: 'Sorry — another Easer just accepted this job.' });

    // Get Easer profile
    const { data: easer } = await sb.from('profiles').select('full_name, email, tier, has_membership').eq('id', assemblerId).single();
    if (!easer) return res.status(404).json({ error: 'Easer profile not found' });

    // ── Atomic CAS: assign if still unassigned ──
    const { error: assignErr } = await sb.from('bookings').update({
      assembler_id:          assemblerId,
      assembler_name:        easer.full_name,
      assembler_tier:        easer.tier,
      assigned_at:           now,
      assembler_accepted_at: now,
      dispatch_status:       'accepted',
      dispatch_token:        null,
      assignment_token:      null,
    }).eq('id', bookingId).is('assembler_id', null); // atomic guard

    if (assignErr) {
      // assignErr can be null even if 0 rows updated — check the count separately
    }

    // Verify assignment actually happened (assembler_id was null)
    const { data: updated } = await sb.from('bookings').select('assembler_id').eq('id', bookingId).single();
    if (!updated || updated.assembler_id !== assemblerId) {
      return res.status(409).json({ error: 'Sorry — another Easer accepted this job first.' });
    }

    // Mark this offer accepted
    await sb.from('dispatch_offers')
      .update({ offer_status: 'accepted', accepted_at: now })
      .eq('id', offer.id);

    // Supersede all other open offers for this booking
    await sb.from('dispatch_offers')
      .update({ offer_status: 'superseded' })
      .eq('booking_id', bookingId)
      .eq('offer_status', 'sent')
      .neq('id', offer.id);

    // Update Easer's last_assigned_at for fairness scoring
    await sb.from('profiles')
      .update({ last_assigned_at: now })
      .eq('id', assemblerId);

    logActivity(sb, {
      bookingId,
      eventType: 'easer_accepted',
      actorType: 'easer',
      actorId: assemblerId,
      actorName: easer.full_name,
      description: `${easer.full_name} accepted the job via dispatch offer`,
      metadata: { tier: easer.tier, score: offer.dispatch_score, attempt: offer.attempt_number },
    });

    sendNotifications(sb, booking, easer, assemblerId);
    return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref });
  }

  // ── Path 2: Legacy inline tokens (assignment_token or dispatch_token) ─────
  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'This booking is no longer available' });

  const isDispatch   = booking.dispatch_token && booking.dispatch_token === token;
  const isAssignment = booking.assignment_token && booking.assignment_token === token
                    && booking.assembler_id === assemblerId;

  if (!isDispatch && !isAssignment) {
    return res.status(403).json({ error: 'Invalid or expired offer token' });
  }

  if (isDispatch) {
    if (booking.assembler_id) return res.status(409).json({ error: 'Sorry — another Easer just accepted this job.' });
    const offeredTo = booking.dispatch_offered_to || [];
    if (!offeredTo.includes(assemblerId)) {
      return res.status(403).json({ error: 'This job offer was not sent to your account' });
    }
  }

  const { data: easer } = await sb.from('profiles').select('full_name, email, tier, has_membership').eq('id', assemblerId).single();
  if (!easer) return res.status(404).json({ error: 'Easer profile not found' });

  const updateData = {
    assembler_accepted_at: now,
    dispatch_status: 'accepted',
    dispatch_token: null,
    assignment_token: null,
  };
  if (isDispatch) {
    Object.assign(updateData, {
      assembler_id: assemblerId,
      assembler_name: easer.full_name,
      assembler_tier: easer.tier,
      assigned_at: now,
    });
  }

  const updateQuery = sb.from('bookings').update(updateData).eq('id', bookingId);
  const { error: assignErr } = isDispatch
    ? await updateQuery.is('assembler_id', null)
    : await updateQuery;

  if (assignErr) return res.status(409).json({ error: 'Sorry — another Easer accepted this job first' });

  await sb.from('profiles').update({ last_assigned_at: now }).eq('id', assemblerId);

  logActivity(sb, {
    bookingId,
    eventType: 'easer_accepted',
    actorType: 'easer',
    actorId: assemblerId,
    actorName: easer.full_name,
    description: `${easer.full_name} accepted the job (legacy token)`,
    metadata: { tier: easer.tier },
  });

  sendNotifications(sb, booking, easer, assemblerId);
  return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref });
}

function sendNotifications(sb, booking, easer, assemblerId) {
  // Customer: "Your Easer is confirmed"
  if (booking.customer_email) {
    sendEmail({
      to:   booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your Easer is confirmed — ${esc(booking.ref)}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#0097a7">Your Easer is confirmed!</h2>
        <p>Hi ${esc((booking.customer_name||'').split(' ')[0])},</p>
        <p>A professional Easer has been assigned to your job and will arrive on <strong>${esc(booking.date)}</strong> at <strong>${esc(booking.time||'the scheduled time')}</strong>.</p>
        <p>You will receive another notification when your Easer is on their way.</p>
        <p style="color:#6b7280;font-size:0.85rem">Booking ref: ${esc(booking.ref)}</p>
      </div>`,
      replyTo: ownerEmail(),
    }).catch(() => {});
  }

  // Owner: "Job Accepted"
  sendEmail({
    to:   ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Job Accepted — ${esc(booking.ref)} · ${esc(easer.full_name)}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h2 style="color:#0097a7">Job Accepted</h2>
      <p><strong>${esc(easer.full_name)}</strong> (${esc(easer.tier)}${easer.has_membership?' · Member':''}) accepted booking <strong>${esc(booking.ref)}</strong>.</p>
      <p><strong>Service:</strong> ${esc(booking.service)}<br>
      <strong>Date:</strong> ${esc(booking.date)} at ${esc(booking.time||'TBD')}<br>
      <strong>Customer:</strong> ${esc(booking.customer_name)}</p>
      <p><a href="https://www.assembleatease.com/owner/" style="color:#0097a7">View in owner dashboard</a></p>
    </div>`,
  }).catch(() => {});
}
