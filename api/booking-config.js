import { isSameDayServiceEnabled, SAME_DAY_FEE_CENTS, SAME_DAY_MIN_LEAD_MINUTES } from './_source-of-truth.js';

// GET /api/booking-config — the ONE source of truth for launch-gated booking
// config the browser needs. The front-end reads the same-day flag from here so
// it can never drift from what the server actually charges: the server owns the
// value, the browser mirrors it. (Previously the flag was hardcoded in two
// places and kept in sync by hand — a real drift risk.)
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Short cache is fine — this only carries a feature flag + static fee constants.
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    sameDay: {
      enabled: isSameDayServiceEnabled(),
      feeCents: SAME_DAY_FEE_CENTS,
      minLeadMinutes: SAME_DAY_MIN_LEAD_MINUTES,
    },
  });
}
