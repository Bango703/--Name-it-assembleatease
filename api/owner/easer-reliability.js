import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { loadEaserStrikeSummary, excuseEaserCancellation } from '../_easer-reliability.js';

/**
 * Owner view of an Easer's cancellation strikes, and the excuse action.
 *   GET  /api/owner/easer-reliability?easerId=...   → strikes + each cancellation
 *   POST /api/owner/easer-reliability { logId, note } → excuse one cancellation
 * Excusing removes the strikes; it does not reactivate a paused Easer. That
 * stays the owner's explicit decision on the Easers page.
 */
export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'GET') {
    const easerId = String(req.query?.easerId || '').trim();
    if (!easerId) return res.status(400).json({ error: 'easerId is required' });
    try {
      const summary = await loadEaserStrikeSummary(sb, easerId);
      return res.status(200).json(summary);
    } catch (error) {
      console.error('[owner-easer-reliability] read failed:', error?.message || error);
      return res.status(503).json({ error: 'Reliability history could not be read.' });
    }
  }

  if (req.method === 'POST') {
    const { logId, note } = req.body || {};
    if (!logId) return res.status(400).json({ error: 'logId is required' });
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : null;
    const result = await excuseEaserCancellation(sb, { logId, excusedBy: 'Owner', note: cleanNote || null });
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
    const summary = await loadEaserStrikeSummary(sb, result.easerId).catch(() => null);
    return res.status(200).json({ ok: true, alreadyExcused: result.alreadyExcused === true, summary });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
