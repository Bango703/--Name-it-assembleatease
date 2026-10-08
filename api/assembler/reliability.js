import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { getSupabase } from '../_supabase.js';
import { EASER_RELIABILITY_POLICY } from '../_source-of-truth.js';
import { loadEaserStrikeSummary } from '../_easer-reliability.js';

/**
 * GET /api/assembler/reliability — the signed-in Easer's own standing:
 * active strikes in the window, the pause limit, and the policy, so the app
 * shows the rule before it is ever applied (Rule 10).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb
    .from('profiles').select('id, role, status').eq('id', authenticated.user.id).maybeSingle();
  if (profileError) return res.status(503).json({ error: 'Your account could not be checked. Please retry.' });
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'An Easer account is required.' });

  try {
    const summary = await loadEaserStrikeSummary(sb, profile.id);
    return res.status(200).json({
      strikes: summary.strikes,
      windowDays: summary.windowDays,
      pauseAtStrikes: summary.pauseAtStrikes,
      paused: profile.status === 'suspended',
      policy: {
        graceMinutes: EASER_RELIABILITY_POLICY.graceMinutes,
        lateNoticeHours: EASER_RELIABILITY_POLICY.lateNoticeHours,
        lateStrikes: EASER_RELIABILITY_POLICY.lateStrikes,
        sameDayStrikes: EASER_RELIABILITY_POLICY.sameDayStrikes,
      },
      events: summary.events.map((e) => ({ kind: e.kind, strikes: e.strikes, excused: e.excused, createdAt: e.createdAt })),
    });
  } catch (error) {
    console.error('[assembler-reliability] read failed:', error?.message || error);
    return res.status(503).json({ error: 'Your reliability record could not be loaded. Please retry.' });
  }
}
