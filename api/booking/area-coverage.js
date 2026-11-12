import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { activeEaserZips, easersCovering, UNCOVERED_AREA_NOTE } from '../_easer-coverage.js';

/**
 * GET /api/booking/area-coverage?zip=78701 — does an active Easer cover this
 * ZIP? The booking page shows the note when not. Says yes or no only; never a
 * count or anyone's location.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!(await rateLimit(ip, 'default'))) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });

  const zip = String(req.query?.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'Enter a five-digit ZIP.' });

  try {
    const covered = easersCovering(await activeEaserZips(getSupabase()), zip) > 0;
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ covered, note: covered ? null : UNCOVERED_AREA_NOTE });
  } catch (error) {
    console.error('[area-coverage]', error?.message || error);
    res.setHeader('Cache-Control', 'no-store');
    // Unknown is not "no pros": the page shows nothing rather than a guess.
    return res.status(503).json({ error: 'Coverage could not be checked right now.' });
  }
}
