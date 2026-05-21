import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

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
  if (!['confirmed', 'en_route', 'arrived', 'in_progress'].includes(booking.status) && booking.status !== 'confirmed') {
    return res.status(400).json({ error: 'Cannot update status for this booking' });
  }

  const { status, field, label } = STAGES[stage];
  const now = new Date().toISOString();

  const update = { status, pipeline_stage: stage, [field]: now };
  const { error: updateErr } = await sb.from('bookings').update(update).eq('id', bookingId);
  if (updateErr) {
    // Fallback: some columns might not exist yet
    const { error: e2 } = await sb.from('bookings').update({ status }).eq('id', bookingId);
    if (e2) return res.status(500).json({ error: 'Failed to update status' });
  }

  // Notify owner of significant stage changes
  if (stage === 'en_route' || stage === 'in_progress') {
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `${label} — ${esc(booking.ref)} · ${esc(booking.service)}`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:1.5rem">
        <p style="font-size:1.1rem;font-weight:700;color:#0097a7">${label}</p>
        <p><strong>${esc(booking.assembler_name || 'Easer')}</strong> updated status to <strong>${label}</strong></p>
        <p>Booking: <strong>${esc(booking.ref)}</strong> — ${esc(booking.service)}<br>
        Customer: ${esc(booking.customer_name)}<br>
        Address: ${esc(booking.address)}<br>
        Time: ${esc(booking.time || 'TBD')}</p>
        <p style="margin-top:1rem"><a href="https://www.assembleatease.com/owner/" style="color:#0097a7">View in Dashboard</a></p>
      </div>`,
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, stage, label });
}
