import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { createClient } from '@supabase/supabase-js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * POST /api/booking/checkin
 * Assembler marks themselves as arrived on-site.
 * Requires Bearer JWT (assembler auth).
 * Body: { bookingId } or { ref }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify JWT
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.replace('Bearer ', '');
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { bookingId, ref } = req.body || {};
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  // Fetch the booking
  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.assembler_id !== user.id) return res.status(403).json({ error: 'You are not assigned to this booking' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Booking is not in confirmed status' });
  if (!booking.assembler_accepted_at) return res.status(400).json({ error: 'You must accept the assignment first' });
  if (booking.checked_in_at) return res.status(400).json({ error: 'Already checked in for this booking' });

  // Update check-in timestamp
  const { error: updateErr } = await sb
    .from('bookings')
    .update({ checked_in_at: new Date().toISOString() })
    .eq('id', booking.id);

  if (updateErr) {
    console.error('Check-in update error:', updateErr);
    return res.status(500).json({ error: 'Failed to record check-in' });
  }

  // Get assembler name
  const { data: assemblerProfile } = await sb
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single();
  const assemblerName = assemblerProfile?.full_name || 'Your assembler';
  const assemblerFirst = assemblerName.split(' ')[0];

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  // Notify owner
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `On-Site Check-in — ${esc(booking.ref)}`,
      html: `<p><strong>${esc(assemblerName)}</strong> has checked in on-site for booking <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}) at ${timeStr}.</p>
<p>Customer: ${esc(booking.customer_name)} | Address: ${esc(booking.address)}</p>`,
    });
  } catch (e) { console.error('Check-in owner notify error:', e); }

  // Notify customer
  if (booking.customer_email) {
    try {
      await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        replyTo: ownerEmail(),
        subject: `Your assembler has arrived — ${esc(booking.ref)}`,
        html: buildCheckInEmail({
          customerFirst: (booking.customer_name || 'Customer').split(' ')[0],
          assemblerFirst,
          service: booking.service,
          time: timeStr,
          ref: booking.ref,
        }),
      });
    } catch (e) { console.error('Check-in customer notify error:', e); }
  }

  return res.status(200).json({ ok: true, checkedInAt: new Date().toISOString() });
}

function buildCheckInEmail({ customerFirst, assemblerFirst, service, time, ref }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;margin-bottom:24px"><tr><td style="padding:20px 24px;text-align:center">
      <p style="margin:0;font-size:40px">&#128075;</p>
      <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#065f46">${esc(assemblerFirst)} has arrived!</p>
      <p style="margin:4px 0 0;font-size:13px;color:#047857">Checked in at ${esc(time)}</p>
    </td></tr></table>
    <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Hi ${esc(customerFirst)}, your assembler <strong>${esc(assemblerFirst)}</strong> has checked in for your <strong>${esc(service)}</strong> appointment. They are ready to get started.</p>
    <p style="margin:0;font-size:13px;color:#71717a">Booking ref: <code>${esc(ref)}</code></p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}
