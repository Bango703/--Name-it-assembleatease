import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { adjustActiveJobs } from './_active-jobs.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/booking/assign
 * Owner assigns a confirmed booking to an assembler.
 * Body: { bookingId, assemblerId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, assemblerId, reassign } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const sb = getSupabase();

  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Only confirmed bookings can be assigned' });
  if (booking.assembler_id && !reassign) return res.status(400).json({ error: 'Booking already assigned. Pass reassign:true to override.' });

  // Verify assembler exists and is eligible
  const { data: assembler, error: aErr } = await sb
    .from('profiles')
    .select('id, full_name, email, status, tier, identity_verified')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .single();

  if (aErr || !assembler) return res.status(404).json({ error: 'Easer not found' });
  if (assembler.status !== 'active') {
    return res.status(400).json({ error: `Easer account is ${assembler.status || 'not active'}. Only active Easers can be assigned.` });
  }
  if (!['starter', 'professional', 'elite'].includes(assembler.tier)) {
    return res.status(400).json({ error: 'Easer must have a valid tier (Starter, Professional, or Elite).' });
  }
  if (!assembler.identity_verified) {
    return res.status(400).json({ error: 'Easer must be identity verified before assignment.' });
  }

  // Cancel any open dispatch offers so Easers don't get a stale offer email
  await sb.from('dispatch_offers')
    .update({ offer_status: 'cancelled' })
    .eq('booking_id', bookingId)
    .eq('offer_status', 'sent');

  // Generate secure assignment token
  const token = crypto.randomUUID();

  // Atomic CAS: for new assignments, only proceed if still unassigned
  const updateQuery = sb.from('bookings').update({
    assembler_id: assemblerId,
    assembler_name: assembler.full_name,
    assembler_tier: assembler.tier,
    assigned_at: new Date().toISOString(),
    assignment_token: token,
    assembler_accepted_at: null,
    dispatch_token: null,
    dispatch_status: null,
    dispatch_paused: true,       // pause auto-dispatch once manually assigned
    needs_manual_dispatch: false,
  }).eq('id', bookingId);

  const { error: updateErr } = reassign
    ? await updateQuery                            // reassign: override any current assignment
    : await updateQuery.is('assembler_id', null);  // new assign: atomic guard

  if (updateErr) {
    console.error('Assign booking error:', updateErr);
    return res.status(500).json({ error: 'Failed to assign booking' });
  }

  // Verify the assignment actually landed (for non-reassign CAS check)
  if (!reassign) {
    const { data: check } = await sb.from('bookings').select('assembler_id').eq('id', bookingId).single();
    if (!check || check.assembler_id !== assemblerId) {
      return res.status(409).json({ error: 'Booking was just assigned to another Easer. Refresh and try again.' });
    }
  }

  // Update active_jobs_today counters (best-effort, non-blocking):
  // - Increment the new Easer's count
  // - If this is a reassignment to a *different* Easer, decrement the old one
  const prevEaserId = booking.assembler_id; // captured before the DB update
  adjustActiveJobs(sb, assemblerId, +1).catch(() => {});
  if (reassign && prevEaserId && prevEaserId !== assemblerId) {
    adjustActiveJobs(sb, prevEaserId, -1).catch(() => {});
  }

  // Send assembler notification email with Accept/Decline links
  const firstName = (assembler.full_name || 'Easer').split(' ')[0];
  const acceptUrl = `${SITE}/assembler/my-assignments?accept=${bookingId}&token=${token}`;
  const declineUrl = `${SITE}/assembler/my-assignments?decline=${bookingId}&token=${token}`;

  try {
    await sendEmail({
      to: assembler.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: ownerEmail(),
      subject: `New Job Assignment — ${esc(booking.service)}`,
      html: buildAssignmentEmail({
        firstName,
        service: booking.service,
        date: booking.date,
        time: booking.time,
        address: booking.address,
        details: booking.details,
        customerName: (booking.customer_name || '').split(' ')[0],
        acceptUrl,
        declineUrl,
        ref: booking.ref,
      }),
    });
  } catch (e) {
    console.error('Assignment email error:', e);
  }

  // Push notification — non-blocking
  sendPushToUser(assemblerId, {
    title: '🔧 New Job Assigned!',
    body:  (booking.service || 'Service') + ' · ' + (booking.date || '') + (booking.time ? ' · ' + booking.time : ''),
    url:   '/assembler/my-assignments',
    jobId: booking.id,
    urgent: true,
  }).catch(e => console.error('Push notification error:', e));

  return res.status(200).json({ ok: true, assignedTo: assembler.full_name });
}

function buildAssignmentEmail({ firstName, service, date, time, address, details, customerName, acceptUrl, declineUrl, ref }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:32px 24px">
    <div style="text-align:center;margin-bottom:20px">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </div>
    <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#1a1a1a;text-align:center">New Job Assignment</p>
    <p style="margin:0 0 24px;font-size:14px;color:#52525b;text-align:center">Hi ${esc(firstName)}, you've been assigned a new job.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
        <tr><td style="padding:6px 0;color:#71717a;width:110px">Reference</td><td style="padding:6px 0;font-weight:600">${esc(ref)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Service</td><td style="padding:6px 0;font-weight:600">${esc(service)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Customer</td><td style="padding:6px 0">${esc(customerName)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Date</td><td style="padding:6px 0">${esc(date || 'TBD')}${time ? ' at ' + esc(time) : ''}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Address</td><td style="padding:6px 0">${esc(address || 'Provided on acceptance')}</td></tr>
        ${details ? `<tr><td style="padding:6px 0;color:#71717a;vertical-align:top">Details</td><td style="padding:6px 0">${esc(details)}</td></tr>` : ''}
      </table>
    </td></tr></table>
    <div style="text-align:center;margin-bottom:16px">
      <a href="${acceptUrl}" style="display:inline-block;background:#0097a7;color:#fff;font-size:14px;font-weight:600;padding:12px 36px;border-radius:6px;text-decoration:none;margin-right:8px">Accept Job</a>
      <a href="${declineUrl}" style="display:inline-block;background:#f4f4f5;color:#71717a;font-size:14px;font-weight:600;padding:12px 36px;border-radius:6px;text-decoration:none;border:1px solid #e4e4e7">Decline</a>
    </div>
    <p style="margin:0;font-size:12px;color:#a1a1aa;text-align:center">Please respond within 24 hours. If you don't respond, the job may be reassigned.</p>
  </td></tr></table>
  <p style="text-align:center;font-size:11px;color:#a1a1aa;margin-top:16px">AssembleAtEase &bull; Austin, TX</p>
</div></body></html>`;
}
