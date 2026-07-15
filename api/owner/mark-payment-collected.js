import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';

// Owner marks the cash/offline payment for an owner-created booking as collected.
// Only applies to source='owner_manual' bookings (online bookings track payment
// through Stripe). Idempotent.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref } = req.body || {};
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();
  let query = sb.from('bookings').select('id, ref, source, payment_collected, total_price');
  query = bookingId ? query.eq('id', bookingId) : query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();
  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.source !== 'owner_manual') {
    return res.status(409).json({
      error: 'Payment collection is tracked automatically for online bookings.',
      code: 'NOT_AN_OWNER_BOOKING',
    });
  }
  if (booking.payment_collected === true) {
    return res.status(200).json({ ok: true, alreadyCollected: true, bookingId: booking.id, ref: booking.ref });
  }

  const now = new Date().toISOString();
  const { data: rows, error: updateErr } = await sb.from('bookings').update({
    payment_collected: true,
    payment_collected_at: now,
    payment_collected_by: 'owner',
  })
    .eq('id', booking.id)
    .eq('source', 'owner_manual')
    .eq('payment_collected', false)
    .select('id');

  if (updateErr) {
    console.error('Mark payment collected error:', updateErr);
    return res.status(500).json({ error: 'Failed to record payment collection.' });
  }
  if (!rows?.length) {
    return res.status(200).json({ ok: true, alreadyCollected: true, bookingId: booking.id, ref: booking.ref });
  }

  logActivity(sb, {
    bookingId: booking.id,
    eventType: 'payment_collected',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Owner recorded offline payment collected — $${(Number(booking.total_price || 0) / 100).toFixed(2)}.`,
    metadata: { source: 'owner_manual' },
  }).catch(e => console.warn('Payment-collected activity log skipped:', e?.message || e));

  return res.status(200).json({ ok: true, collected: true, bookingId: booking.id, ref: booking.ref });
}
