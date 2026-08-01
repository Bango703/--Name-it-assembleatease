import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

// GET /api/owner/quote-orphans  (owner-only, read-only)
// Lists customers who saved a card for a custom quote (SetupIntent, source
// 'quote_booking') but whose booking never got created — so they never showed
// up in "Quotes to Price" and were never contacted. Their cards are saved and
// valid; the owner can reach out and quote them. Nothing is charged or changed.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = getSupabase();

  let setupIntents;
  try {
    // Stripe list has no server-side metadata filter; pull the recent window and
    // filter here. Plenty for launch scale.
    setupIntents = await stripe.setupIntents.list({ limit: 100 });
  } catch (err) {
    console.error('quote-orphans setup-intent list failed:', err?.message || err);
    return res.status(502).json({ error: 'Could not load Stripe card-save history.' });
  }

  const candidates = (setupIntents.data || []).filter(
    si => si.status === 'succeeded' && si.metadata?.source === 'quote_booking',
  );

  const orphans = [];
  const customerCache = new Map();
  for (const si of candidates) {
    const pmId = typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method?.id || null);
    const customerId = typeof si.customer === 'string' ? si.customer : (si.customer?.id || null);

    // Skip if a booking was actually created for this saved card (normal path).
    if (pmId) {
      const { data: linked } = await sb.from('bookings')
        .select('id').eq('stripe_payment_method_id', pmId).limit(1).maybeSingle();
      if (linked) continue;
    }
    if (customerId) {
      const { data: byCustomer } = await sb.from('bookings')
        .select('id').eq('stripe_customer_id', customerId).eq('payment_status', 'card_saved').limit(1).maybeSingle();
      if (byCustomer) continue;
    }

    let name = '';
    let email = String(si.metadata?.email || '').trim();
    if (customerId) {
      let cust = customerCache.get(customerId);
      if (cust === undefined) {
        try { cust = await stripe.customers.retrieve(customerId); }
        catch { cust = null; }
        customerCache.set(customerId, cust);
      }
      if (cust && !cust.deleted) {
        name = cust.name || name;
        email = cust.email || email;
      }
    }

    orphans.push({
      setupIntentId: si.id,
      customerId,
      email,
      name,
      cardOnFile: Boolean(pmId),
      savedAt: si.created ? new Date(si.created * 1000).toISOString() : null,
    });
  }

  orphans.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  return res.status(200).json({ count: orphans.length, orphans });
}
