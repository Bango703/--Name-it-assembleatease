import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';

const STAGES = {
  en_route:    { status: 'en_route',    field: 'en_route_at',    label: 'On the way' },
  arrived:     { status: 'arrived',     field: 'checked_in_at',  label: 'Arrived' },
  in_progress: { status: 'in_progress', field: 'job_started_at', label: 'Job started' },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await userClient.auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { bookingId, stage } = req.body;
  if (!bookingId || !stage) return res.status(400).json({ error: 'bookingId and stage required' });
  if (!STAGES[stage]) return res.status(400).json({ error: 'Invalid stage. Use: en_route, arrived, in_progress' });

  const sb = getSupabase();
  const { data: booking } = await sb.from('bookings').select('*').eq('id', bookingId).single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.assembler_id !== user.id) return res.status(403).json({ error: 'Not your booking' });

  // Hard-block terminal states — completed/cancelled bookings must never be updated
  if (['completed', 'cancelled', 'declined', 'refunded'].includes(booking.status)) {
    return res.status(400).json({ error: `Cannot update a ${booking.status} booking` });
  }
  if (!['confirmed', 'en_route', 'arrived', 'in_progress'].includes(booking.status)) {
    return res.status(400).json({ error: 'Booking is not in an updatable state' });
  }

  const { status, field, label } = STAGES[stage];
  const now = new Date().toISOString();

  // Primary update: status + pipeline_stage + timestamp field
  const update = { status, pipeline_stage: stage, [field]: now };
  const { error: updateErr } = await sb.from('bookings').update(update).eq('id', bookingId);
  if (updateErr) {
    // Fallback: pipeline_stage column may not exist — preserve the timestamp field
    const { error: e2 } = await sb.from('bookings').update({ status, [field]: now }).eq('id', bookingId);
    if (e2) return res.status(500).json({ error: 'Failed to update status' });
  }

  const easerFirstName = (booking.assembler_name || 'Your Easer').split(' ')[0];
  const customerFirstName = (booking.customer_name || 'there').split(' ')[0];

  // Log activity
  logActivity(sb, { bookingId, eventType: stage, actorType: 'easer', actorId: user.id, actorName: booking.assembler_name || 'Easer', description: `${booking.assembler_name || 'Easer'} — ${label}` });

  // Notify owner
  sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `${label} — ${esc(booking.ref)} · ${esc(booking.service)}`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:1.5rem"><p style="font-size:1.1rem;font-weight:700;color:#0097a7">${label}</p><p><strong>${esc(booking.assembler_name||'Easer')}</strong> — ${esc(booking.service)}<br>Customer: ${esc(booking.customer_name)}<br>Address: ${esc(booking.address)}</p><p><a href="https://www.assembleatease.com/owner/" style="color:#0097a7">View Dashboard</a></p></div>`,
    meta: { bookingId, notificationType: stage, recipientType: 'owner' },
  }).catch(() => {});

  // Notify customer at key stages
  const customerMessages = {
    en_route: {
      subject: `Your Easer is on the way — ${esc(booking.ref)}`,
      body: `${easerFirstName} is heading to you now and should arrive soon at ${esc(booking.time || 'the scheduled time')}.`,
    },
    arrived: {
      subject: `Your Easer has arrived — ${esc(booking.ref)}`,
      body: `${easerFirstName} has arrived at your location and is ready to get started.`,
    },
    in_progress: {
      subject: `Your job is underway — ${esc(booking.ref)}`,
      body: `Great news — ${easerFirstName} has started working on your ${esc(booking.service)}.`,
    },
  };

  if (booking.customer_email && customerMessages[stage]) {
    const msg = customerMessages[stage];
    sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: msg.subject,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem"><h2 style="color:#0097a7">${label}</h2><p>Hi ${esc(customerFirstName)},</p><p>${msg.body}</p><p style="margin-top:1rem;color:#6b7280;font-size:0.85rem">Booking: ${esc(booking.ref)} · Questions? Reply to this email.</p></div>`,
      replyTo: ownerEmail(),
      meta: { bookingId, notificationType: stage, recipientType: 'customer' },
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, stage, label });
}
