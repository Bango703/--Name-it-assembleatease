import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { findQuoteOrphans } from '../_quote-orphans-core.js';

// GET /api/owner/quote-orphans  (owner-only, read-only)
//
// Customers who saved a card but whose booking never got created — so they
// never showed up in the queue and were never contacted. Their cards are saved
// and valid; the owner can reach out and quote them. Nothing is charged or
// changed.
//
// Detection lives in _quote-orphans-core.js because the alerting cron answers
// the same question. Two copies would eventually disagree, and a dashboard that
// disagrees with an alert email is worse than either alone.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = getSupabase();

  let orphans;
  try {
    orphans = await findQuoteOrphans(sb, { stripe });
  } catch (err) {
    console.error('quote-orphans lookup failed:', err?.message || err);
    return res.status(502).json({ error: 'Could not load Stripe card-save history.' });
  }

  return res.status(200).json({ count: orphans.length, orphans });
}
