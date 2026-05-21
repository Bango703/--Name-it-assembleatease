import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();

  if (req.method === 'GET') {
    const { bookingId } = req.query;
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });

    const { data, error } = await sb
      .from('activity_logs')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: 'Failed to load activity: ' + error.message });
    return res.status(200).json({ activity: data || [] });
  }

  if (req.method === 'POST') {
    const { bookingId, description, eventType = 'owner_action', metadata } = req.body;
    if (!bookingId || !description) return res.status(400).json({ error: 'bookingId and description required' });

    const { error } = await sb.from('activity_logs').insert({
      booking_id: bookingId,
      event_type: eventType,
      actor_type: 'owner',
      actor_name: 'Owner',
      description,
      metadata: metadata || null,
    });

    if (error) return res.status(500).json({ error: 'Failed to log activity: ' + error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
