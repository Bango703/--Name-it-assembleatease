import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from './_activity.js';

const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/booking/accept-dispatch
 * Easer accepts a dispatched job offer. Verifies token, assigns if still open.
 * Body: { bookingId, token, assemblerId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId, token, assemblerId } = req.body;
  if (!bookingId || !token || !assemblerId) {
    return res.status(400).json({ error: 'bookingId, token, and assemblerId are required' });
  }

  const sb = getSupabase();

  // Fetch booking + verify token
  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'This booking is no longer available' });

  // Support both dispatch token (offered to multiple) and assignment token (directly assigned)
  const isDispatch = booking.dispatch_token && booking.dispatch_token === token;
  const isAssignment = booking.assignment_token && booking.assignment_token === token &&
    booking.assembler_id === assemblerId; // manual assign: already assigned to this Easer

  if (!isDispatch && !isAssignment) {
    return res.status(403).json({ error: 'Invalid or expired offer token' });
  }

  // For dispatch offers: verify this Easer was in the offer list
  if (isDispatch) {
    if (booking.assembler_id) return res.status(409).json({ error: 'Sorry — another Easer just accepted this job.' });
    const offeredTo = booking.dispatch_offered_to || [];
    if (!offeredTo.includes(assemblerId)) {
      return res.status(403).json({ error: 'This job offer was not sent to your account' });
    }
  }

  // Get Easer profile
  const { data: easer } = await sb.from('profiles').select('full_name, email, tier, has_membership').eq('id', assemblerId).single();
  if (!easer) return res.status(404).json({ error: 'Easer profile not found' });

  // Accept the job — set assembler_accepted_at so check-in button appears
  const updateData = {
    assembler_accepted_at: new Date().toISOString(),
    dispatch_status: 'accepted',
    dispatch_token: null,
    assignment_token: null,
  };
  if (isDispatch) {
    // Also assign for dispatch flow (not yet assigned)
    Object.assign(updateData, {
      assembler_id: assemblerId,
      assembler_name: easer.full_name,
      assembler_tier: easer.tier,
      assigned_at: new Date().toISOString(),
    });
  }

  const updateQuery = sb.from('bookings').update(updateData).eq('id', bookingId);
  // For dispatch: atomic check — only if still unassigned
  const { error: assignErr } = isDispatch
    ? await updateQuery.is('assembler_id', null)
    : await updateQuery;

  if (assignErr) {
    console.error('Accept dispatch assign error:', assignErr);
    return res.status(409).json({ error: 'Sorry — another Easer accepted this job first' });
  }

  // Update Easer's last assigned time for fairness tracking
  await sb.from('profiles').update({ last_assigned_at: new Date().toISOString() }).eq('id', assemblerId);

  // Log activity
  logActivity(sb, { bookingId, eventType: 'easer_accepted', actorType: 'easer', actorId: assemblerId, actorName: easer.full_name, description: `${easer.full_name} accepted the job`, metadata: { tier: easer.tier } });

  // Notify customer — "Your Easer is confirmed"
  if (booking.customer_email) {
    sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your Easer is confirmed — ' + esc(booking.ref),
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#0097a7">Your Easer is confirmed!</h2>
        <p>Hi ${esc((booking.customer_name||'').split(' ')[0])},</p>
        <p>A professional Easer has been assigned to your job and will arrive on <strong>${esc(booking.date)}</strong> at <strong>${esc(booking.time||'the scheduled time')}</strong>.</p>
        <p style="margin-top:1rem">You will receive another notification when your Easer is on their way. Questions? Reply to this email.</p>
        <p style="margin-top:1rem;color:#6b7280;font-size:0.85rem">Booking ref: ${esc(booking.ref)}</p>
      </div>`,
      replyTo: ownerEmail(),
    }).catch(() => {});
  }

  // Notify owner
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: '✓ Job Accepted — ' + esc(booking.ref) + ' · ' + esc(easer.full_name),
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#0097a7;margin-bottom:1rem">Job Accepted</h2>
        <p><strong>${esc(easer.full_name)}</strong> (${esc(easer.tier)}${easer.has_membership?' · Member':''}) accepted booking <strong>${esc(booking.ref)}</strong>.</p>
        <p style="margin-top:0.75rem"><strong>Service:</strong> ${esc(booking.service)}<br>
        <strong>Date:</strong> ${esc(booking.date)} at ${esc(booking.time||'TBD')}<br>
        <strong>Address:</strong> ${esc(booking.address)}<br>
        <strong>Customer:</strong> ${esc(booking.customer_name)} · ${esc(booking.customer_email)}</p>
        <p style="margin-top:1rem;color:#6b7280;font-size:0.875rem">View in the <a href="${SITE}/owner/" style="color:#0097a7">owner dashboard</a>.</p>
      </div>`,
      replyTo: easer.email,
    });
  } catch(e) { console.error('Accept dispatch owner email error:', e); }

  return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref });
}
