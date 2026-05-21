import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { bookingId } = req.query;
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    const { data, error } = await sb
      .from('booking_notes')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load notes: ' + error.message });
    return res.status(200).json({ notes: data || [] });
  }

  if (req.method === 'POST') {
    const { bookingId, note, author = 'Owner' } = req.body;
    if (!bookingId || !note?.trim()) return res.status(400).json({ error: 'bookingId and note required' });
    const { data, error } = await sb.from('booking_notes')
      .insert({ booking_id: bookingId, note: note.trim(), author })
      .select().single();
    if (error) return res.status(500).json({ error: 'Failed to save note: ' + error.message });
    return res.status(200).json({ ok: true, note: data });
  }

  if (req.method === 'DELETE') {
    const { noteId } = req.body;
    if (!noteId) return res.status(400).json({ error: 'noteId required' });
    await sb.from('booking_notes').delete().eq('id', noteId);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
