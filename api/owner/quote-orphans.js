import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  findQuoteOrphans,
  QUOTE_ORPHAN_RESOLVED_EVENT,
  WATCHED_SOURCES,
} from '../_quote-orphans-core.js';

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
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = getSupabase();

  if (req.method === 'POST') {
    const setupIntentId = String(req.body?.setupIntentId || '').trim();
    if (!/^seti_[A-Za-z0-9]+$/.test(setupIntentId)) {
      return res.status(400).json({ error: 'Valid quote request identifier required' });
    }

    let setupIntent;
    try {
      setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    } catch (error) {
      return res.status(404).json({ error: 'Quote request not found.' });
    }
    if (setupIntent.status !== 'succeeded' || !WATCHED_SOURCES.includes(setupIntent.metadata?.source)) {
      return res.status(409).json({ error: 'This card save is not an outstanding quote request.' });
    }

    const { error } = await sb.from('operational_events').upsert({
      request_id: `quote-orphan-resolved:${setupIntentId}`,
      event_type: QUOTE_ORPHAN_RESOLVED_EVENT,
      route: '/api/owner/quote-orphans',
      method: 'POST',
      actor_role: 'owner',
      stage: 'resolution',
      status_code: 200,
      reason_code: 'quote_orphan_handled',
      reason_detail: setupIntentId,
      mutation_result: 'resolved',
    }, { onConflict: 'request_id,event_type' });

    if (error) {
      console.error('quote-orphan resolution failed:', error.message || error);
      return res.status(500).json({ error: 'Could not mark this request resolved.' });
    }
    return res.status(200).json({ resolved: true, setupIntentId });
  }

  let orphans;
  try {
    orphans = await findQuoteOrphans(sb, { stripe });
  } catch (err) {
    console.error('quote-orphans lookup failed:', err?.message || err);
    return res.status(502).json({ error: 'Could not load Stripe card-save history.' });
  }

  return res.status(200).json({ count: orphans.length, orphans });
}
