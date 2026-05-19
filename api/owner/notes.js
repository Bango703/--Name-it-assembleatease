import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'POST') {
    const { bookingId, notes } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    const { error } = await sb.from('bookings').update({ owner_notes: notes || null }).eq('id', bookingId);
    if (error) return res.status(500).json({ error: 'Failed to save notes' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
