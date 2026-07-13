import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

const VALID_STATUSES = new Set(['not_requested', 'requested', 'received', 'validated', 'not_required']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const assemblerId = String(req.body?.assemblerId || '').trim();
  const status = String(req.body?.status || '').trim().toLowerCase();
  const notes = String(req.body?.notes || '').trim();
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid W-9 status' });
  if (notes.length > 500) return res.status(400).json({ error: 'Notes must be 500 characters or fewer' });
  if (/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b|\b\d{2}-?\d{7}\b/.test(notes)) {
    return res.status(400).json({ error: 'Do not enter an SSN, EIN, or raw W-9 contents. Store only a secure-system reference.' });
  }

  const sb = getSupabase();
  const now = new Date().toISOString();
  const { data: profile } = await sb.from('profiles')
    .select('id')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();
  if (!profile) return res.status(404).json({ error: 'Easer not found' });

  const { error: updateError } = await sb.rpc('record_easer_w9_status', {
    p_assembler_id: assemblerId,
    p_status: status,
    p_notes: notes || null,
    p_recorded_by: 'owner',
  });
  if (updateError) {
    console.error('W-9 status transaction failed:', updateError);
    return res.status(500).json({ error: 'Could not record W-9 status' });
  }

  return res.status(200).json({ ok: true, assemblerId, status, updatedAt: now });
}
