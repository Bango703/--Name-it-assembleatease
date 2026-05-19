import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { assemblerId } = req.body;
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const sb = getSupabase();

  // Block delete if they have active bookings
  const { data: active } = await sb
    .from('bookings')
    .select('id, ref, status')
    .eq('assembler_id', assemblerId)
    .in('status', ['pending', 'confirmed']);

  if (active && active.length > 0) {
    return res.status(400).json({
      error: 'Cannot delete — Easer has ' + active.length + ' active booking(s): ' +
        active.map(b => b.ref).join(', ') + '. Reassign or complete them first.'
    });
  }

  // Remove assembler_id from any completed bookings (keep history, just unlink)
  await sb.from('bookings').update({ assembler_id: null }).eq('assembler_id', assemblerId);

  // Delete the profile
  const { error } = await sb.from('profiles').delete().eq('id', assemblerId);
  if (error) {
    console.error('Delete easer error:', error);
    return res.status(500).json({ error: 'Failed to delete Easer' });
  }

  console.log(JSON.stringify({ audit: true, action: 'delete_easer', actor: 'owner', assemblerId, timestamp: new Date().toISOString() }));
  return res.status(200).json({ ok: true });
}
