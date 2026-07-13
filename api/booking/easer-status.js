import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import {
  BOOKING_STATUS,
  EASER_STAGE,
  ACTIVE_BOOKING_STATUSES,
  TERMINAL_BOOKING_STATUSES,
} from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';

const STAGES = {
  [EASER_STAGE.EN_ROUTE]:    { status: BOOKING_STATUS.EN_ROUTE,    field: 'en_route_at',    label: 'On the way' },
  [EASER_STAGE.ARRIVED]:     { status: BOOKING_STATUS.ARRIVED,     field: 'checked_in_at',  label: 'Arrived' },
  [EASER_STAGE.IN_PROGRESS]: { status: BOOKING_STATUS.IN_PROGRESS, field: 'job_started_at', label: 'Job started' },
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
  if (!booking.assembler_accepted_at) {
    return res.status(409).json({ error: 'Accept this assignment before updating the job status.' });
  }

  // Hard-block terminal states — completed/cancelled bookings must never be updated
  if (TERMINAL_BOOKING_STATUSES.includes(booking.status)) {
    return res.status(400).json({ error: `Cannot update a ${booking.status} booking` });
  }
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
    return res.status(400).json({ error: 'Booking is not in an updatable state' });
  }

  const { status, field, label } = STAGES[stage];
  if (booking.status === status && booking[field]) {
    return res.status(200).json({ ok: true, stage, label, alreadyUpdated: true });
  }
  if (booking.status === status && !booking[field]) {
    return res.status(409).json({ error: `Booking is missing its ${field} timestamp. Owner review is required.` });
  }
  const transitionErr = getTransitionError(booking.status, status);
  if (transitionErr) return res.status(400).json({ error: transitionErr });
  const now = new Date().toISOString();

  // Primary update: status + pipeline_stage + timestamp field
  const update = { status, pipeline_stage: stage, [field]: now };
  const { data: updatedRows, error: updateErr } = await sb.from('bookings')
    .update(update)
    .eq('id', bookingId)
    .eq('assembler_id', user.id)
    .eq('status', booking.status)
    .select('id');
  if (updateErr || !updatedRows?.length) {
    return res.status(409).json({ error: 'Job status changed before this update. Refresh and try again.' });
  }

  const easerFirstName = (booking.assembler_name || 'Your Easer').split(' ')[0];
  const customerFirstName = (booking.customer_name || 'there').split(' ')[0];

  // Log activity
  await logActivity(sb, { bookingId, eventType: stage, actorType: 'easer', actorId: user.id, actorName: booking.assembler_name || 'Easer', description: `${booking.assembler_name || 'Easer'} — ${label}` });

  // Notify owner
  const ownerNotice = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `${label} — ${esc(booking.ref)} · ${esc(booking.service)}`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:1.5rem"><p style="font-size:1.1rem;font-weight:700;color:#00BFFF">${label}</p><p><strong>${esc(booking.assembler_name||'Easer')}</strong> — ${esc(booking.service)}<br>Customer: ${esc(booking.customer_name)}<br>Address: ${esc(booking.address)}</p><p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">View Dashboard</a></p></div>`,
    meta: { bookingId, notificationType: stage, recipientType: 'owner' },
  }).catch(err => ({ ok: false, error: err?.message || String(err) }));

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

  let customerNotice = { ok: true, skipped: true, reason: 'customer_email_missing' };
  if (booking.customer_email && customerMessages[stage]) {
    const msg = customerMessages[stage];
    customerNotice = await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: msg.subject,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem"><h2 style="color:#00BFFF">${label}</h2><p>Hi ${esc(customerFirstName)},</p><p>${msg.body}</p><p style="margin-top:1rem;color:#6b7280;font-size:0.85rem">Booking: ${esc(booking.ref)} · Questions? Reply to this email.</p></div>`,
      replyTo: ownerEmail(),
      meta: { bookingId, notificationType: stage, recipientType: 'customer' },
    }).catch(err => ({ ok: false, error: err?.message || String(err) }));
  }

  const notificationFailures = [];
  if (!ownerNotice?.ok) notificationFailures.push({ recipient: 'owner', error: ownerNotice?.error || 'Owner email failed' });
  if (!customerNotice?.ok) notificationFailures.push({ recipient: 'customer', error: customerNotice?.error || 'Customer email failed' });
  if (notificationFailures.length) {
    await logActivity(sb, {
      bookingId,
      eventType: 'status_notification_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `${label} status saved, but ${notificationFailures.map(f => f.recipient).join(' and ')} notification failed`,
      metadata: { stage, failures: notificationFailures },
    });
  }
  const auditFailures = [
    { recipient: 'owner', result: ownerNotice },
    { recipient: 'customer', result: customerNotice },
  ].filter(item => item.result?.logged === false);
  if (auditFailures.length) {
    await logActivity(sb, {
      bookingId,
      eventType: 'notification_audit_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `${label} notifications were attempted, but one or more attempt logs could not be saved`,
      metadata: { stage, failures: auditFailures.map(item => ({ recipient: item.recipient, error: item.result?.logError || null })) },
    });
  }

  return res.status(200).json({ ok: true, stage, label, notificationFailures, auditFailures });
}
