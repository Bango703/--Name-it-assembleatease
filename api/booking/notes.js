import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { bookingId } = req.query;
    if (!isUuid(bookingId)) return res.status(400).json({ error: 'A valid bookingId is required' });
    const { data, error } = await sb
      .from('booking_notes')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load notes: ' + error.message });
    return res.status(200).json({ notes: data || [] });
  }

  if (req.method === 'POST') {
    const { bookingId, note } = req.body || {};
    if (!isUuid(bookingId) || typeof note !== 'string' || !note.trim()) return res.status(400).json({ error: 'Valid bookingId and note are required' });
    if (note.trim().length > 5000) return res.status(400).json({ error: 'Note must be 5,000 characters or fewer' });
    const { data, error } = await sb.from('booking_notes')
      .insert({ booking_id: bookingId, note: note.trim(), author: 'Owner' })
      .select().single();
    if (error) return res.status(500).json({ error: 'Failed to save note: ' + error.message });
    return res.status(200).json({ ok: true, note: data });
  }

  if (req.method === 'DELETE') {
    const { noteId } = req.body || {};
    if (!isUuid(noteId)) return res.status(400).json({ error: 'A valid noteId is required' });
    const { error, data } = await sb.from('booking_notes').delete().eq('id', noteId).select('id');
    if (error) return res.status(500).json({ error: 'Failed to delete note' });
    if (!data?.length) return res.status(404).json({ error: 'Note not found' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
