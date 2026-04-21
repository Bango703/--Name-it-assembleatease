import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * DELETE /api/booking/delete
 * Owner only: archive a cancelled or declined booking (soft delete).
 * Body: { bookingId } or { ref }
 * Only bookings with status 'cancelled' or 'declined' may be deleted.
 */
export default async function handler(req, res) {
  if (req.method !== 'DELETE' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.method === 'DELETE' ? req.body : req.body;
  const { bookingId, ref } = body || {};
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('id, status, ref');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  const deletable = ['cancelled', 'declined'];
  if (!deletable.includes(booking.status)) {
    return res.status(400).json({ error: 'Only cancelled or declined bookings can be deleted' });
  }

  const { error: deleteErr } = await sb
    .from('bookings')
    .delete()
    .eq('id', booking.id);

  if (deleteErr) {
    console.error('Booking delete error:', deleteErr);
    return res.status(500).json({ error: 'Failed to delete booking' });
  }

  return res.status(200).json({ ok: true, deleted: booking.ref });
}
