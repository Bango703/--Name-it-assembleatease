import { getSupabase } from '../_supabase.js';
import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { acknowledgeAnnouncement } from '../_announcements.js';

/**
 * POST /api/assembler/acknowledge-announcement { key }
 * The signed-in Easer taps "I understand" on a policy notice. Stores a dated
 * record on their delivery row and stops further reminders. Only notices whose
 * rule requires acknowledgment accept this.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const authed = await authenticateBearerUser(req);
  if (!authed.ok) return respondWithEaserAccessError(res, authed);

  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'key is required' });

  const sb = getSupabase();
  const { data: profile, error } = await sb.from('profiles').select('id, role').eq('id', authed.user.id).maybeSingle();
  if (error) return res.status(503).json({ error: 'Your account could not be checked. Please retry.' });
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'Easer access required' });

  const result = await acknowledgeAnnouncement(sb, { easerId: profile.id, key });
  if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
  return res.status(200).json({ ok: true, acknowledgedAt: result.acknowledgedAt, alreadyAcknowledged: result.alreadyAcknowledged === true });
}
