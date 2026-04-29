import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // GET — list messages for a booking (owner only)
  if (req.method === 'GET') {
    if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId, ref } = req.query;
    if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref query param required' });
    const sb = getSupabase();
    let bq = sb.from('bookings').select('id');
    if (bookingId) bq = bq.eq('id', bookingId); else bq = bq.eq('ref', ref);
    const { data: bk, error: bkErr } = await bq.single();
    if (bkErr || !bk) return res.status(404).json({ error: 'Booking not found' });
    const { data: msgs, error: msgsErr } = await sb
      .from('messages')
      .select('*')
      .eq('booking_id', bk.id)
      .order('created_at', { ascending: true });
    if (msgsErr) return res.status(500).json({ error: 'Failed to fetch messages' });
    return res.status(200).json({ messages: msgs || [] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId, ref, body: msgBody, sender } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });
  if (!msgBody || !msgBody.trim()) return res.status(400).json({ error: 'Message body is required' });

  const sb = getSupabase();

  // Fetch booking
  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Determine sender
  let resolvedSender;
  if (sender === 'owner') {
    if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
    resolvedSender = 'owner';
  } else {
    // Customer and assembler messages require JWT authentication
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.replace('Bearer ', '');
    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authErr } = await userClient.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    if (sender === 'assembler') {
      // Verify user is the assigned assembler on this booking
      if (!booking.assembler_id || booking.assembler_id !== user.id) {
        return res.status(403).json({ error: 'You are not assigned to this booking' });
      }
      resolvedSender = 'assembler';
    } else {
      // Default: customer
      if (user.email.toLowerCase() !== booking.customer_email.toLowerCase()) {
        return res.status(401).json({ error: 'Unauthorized — email does not match booking' });
      }
      resolvedSender = 'customer';
    }
  }

  // Insert message
  const { data: message, error: insertErr } = await sb
    .from('messages')
    .insert({
      booking_id: booking.id,
      sender: resolvedSender,
      body: msgBody.trim(),
    })
    .select()
    .single();

  if (insertErr) {
    console.error('Message insert error:', insertErr);
    return res.status(500).json({ error: 'Failed to save message' });
  }

  // Send notification email to the other party
  try {
    const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
    const sBody = esc(msgBody.trim());

    if (resolvedSender === 'owner') {
      // Notify customer
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#1a1a1a">New message about your booking</p>
    <p style="margin:0 0 20px;font-size:13px;color:#71717a">Ref: ${esc(booking.ref)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:16px 18px">
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sBody}</p>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b">Reply to this email to respond.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
      await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Message about booking ' + booking.ref,
        html,
        replyTo: ownerEmail(),
      });
    } else if (resolvedSender === 'assembler') {
      // Notify owner about assembler message
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
        subject: 'Assembler Message — ' + booking.ref,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Booking ${esc(booking.ref)} &mdash; Assembler Message</p>
    <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1a1a1a">Message from your assembler</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:16px"><tr><td style="padding:16px 18px">
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sBody}</p>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a">Service: ${esc(booking.service)} &bull; Customer: ${esc(booking.customer_name)}</p>
  </td></tr></table>
</div></body></html>`,
        replyTo: ownerEmail(),
      });
    } else {
      // Customer message — notify owner
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
        subject: 'Customer Reply — ' + booking.ref + ' from ' + booking.customer_name,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Customer Message</td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Booking ${esc(booking.ref)}</p>
    <p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#1a1a1a">Reply from ${esc(booking.customer_name)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:16px 18px">
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sBody}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#1e40af">Contact <strong>${esc(booking.customer_name)}</strong> at <a href="mailto:${esc(booking.customer_email)}" style="color:#1e40af">${esc(booking.customer_email)}</a>.</p>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">AssembleAtEase &bull; Austin, TX</td></tr></table>
</div></body></html>`,
        replyTo: booking.customer_email,
      });
    }
  } catch (emailErr) {
    console.error('Message email error:', emailErr);
  }

  return res.status(200).json({ success: true, message: { id: message.id, sender: resolvedSender } });
}
