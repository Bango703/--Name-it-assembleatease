/**
 * GET /api/config/public-key
 * Returns the Stripe publishable key for frontend use.
 * Safe to expose — publishable keys are intentionally public.
 */
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  // No caching — key changes require immediate propagation (e.g. live→test switch)
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ publishableKey });
}
