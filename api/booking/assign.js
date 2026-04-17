import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

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

  const { bookingId, assemblerId } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const sb = getSupabase();

  // Verify booking exists and is confirmed
  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Only confirmed bookings can be assigned' });
  if (booking.assembler_id) return res.status(400).json({ error: 'Booking is already assigned' });

  // Verify assembler exists and is eligible
  const { data: assembler, error: aErr } = await sb
    .from('profiles')
    .select('id, full_name, email, tier, persona_verified')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .single();

  if (aErr || !assembler) return res.status(404).json({ error: 'Assembler not found' });
  if (!['starter', 'verified', 'elite'].includes(assembler.tier)) {
    return res.status(400).json({ error: 'Assembler must be at least starter tier' });
  }
  if (!assembler.persona_verified) {
    return res.status(400).json({ error: 'Assembler must be identity verified' });
  }

  // Generate secure assignment token
  const token = crypto.randomUUID();

  // Update booking
  const { error: updateErr } = await sb
    .from('bookings')
    .update({
      assembler_id: assemblerId,
      assigned_at: new Date().toISOString(),
      assignment_token: token,
    })
    .eq('id', bookingId);

  if (updateErr) {
    console.error('Assign booking error:', updateErr);
    return res.status(500).json({ error: 'Failed to assign booking' });
  }

  // Send assembler notification email with Accept/Decline links
  const firstName = (assembler.full_name || 'Assembler').split(' ')[0];
  const acceptUrl = `${SITE}/api/booking/accept?token=${token}&action=accept`;
  const declineUrl = `${SITE}/api/booking/accept?token=${token}&action=decline`;

  try {
    await sendEmail({
      to: assembler.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
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
