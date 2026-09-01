import Stripe from 'stripe';

/**
 * _quote-orphans-core.js — the ONE answer to "who saved a card and was never
 * heard from again".
 *
 * WHAT GOES WRONG
 * Checkout saves the card BEFORE it creates the booking:
 *
 *     confirmCardSetup()      card is now on file at Stripe
 *          |                  <-- anything failing here loses the customer
 *     POST /api/booking       the row the owner actually sees
 *
 * If that second call fails — a validation error, a dropped connection, a
 * closed tab — the card is saved and no booking exists. The customer believes
 * they asked for a quote. The owner never learns they existed. Nothing in the
 * platform is watching, because from the database's point of view nothing
 * happened.
 *
 * It is not hypothetical. Two customers sat this way for 34 and 44 days with
 * valid cards on file and zero emails ever sent to them.
 *
 * WHY DETECTION LIVES HERE AND NOT IN A HANDLER
 * The owner panel and the alerting cron must never disagree about who is
 * outstanding — a dashboard showing two while an email says three is exactly
 * the double-talk this codebase forbids. One rule, one module, two callers.
 *
 * STRIPE IS THE TRUTH, DELIBERATELY. The customer may have closed the tab
 * before anything could be reported, so asking our own database would find
 * nothing. Asking Stripe finds every case.
 *
 * IT NEVER WRITES AND NEVER CHARGES. It reads Stripe, reads bookings, and
 * returns a list. Charging a saved card for work nobody has scoped would be a
 * far worse failure than the one it exists to catch.
 */

/** Card-save reasons that are supposed to be followed by a booking. */
export const WATCHED_SOURCES = Object.freeze(['quote_booking', 'future_booking']);
export const QUOTE_ORPHAN_RESOLVED_EVENT = 'quote_orphan_resolved';

export const SOURCE_LABEL = Object.freeze({
  quote_booking: 'custom quote',
  future_booking: 'scheduled appointment',
});

/**
 * Customers whose card save succeeded but whose booking never arrived.
 *
 * `limit` is the Stripe page size. Launch scale fits in one page; the cap is
 * explicit rather than implied so growing past it is a visible decision.
 */
export async function findQuoteOrphans(sb, { stripe, limit = 100 } = {}) {
  const client = stripe || new Stripe(process.env.STRIPE_SECRET_KEY);

  const setupIntents = await client.setupIntents.list({ limit });

  const { data: resolvedRows, error: resolvedError } = await sb
    .from('operational_events')
    .select('reason_detail')
    .eq('event_type', QUOTE_ORPHAN_RESOLVED_EVENT);
  if (resolvedError) throw resolvedError;
  const resolvedIds = new Set((resolvedRows || []).map(row => row.reason_detail));

  const candidates = (setupIntents.data || []).filter(
    si => si.status === 'succeeded'
      && WATCHED_SOURCES.includes(si.metadata?.source)
      && !resolvedIds.has(si.id),
  );

  const orphans = [];
  const customerCache = new Map();

  for (const si of candidates) {
    const pmId = typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method?.id || null);
    const customerId = typeof si.customer === 'string' ? si.customer : (si.customer?.id || null);

    // The normal path: a booking exists for this card. Not an orphan.
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
        try { cust = await client.customers.retrieve(customerId); }
        catch { cust = null; }
        customerCache.set(customerId, cust);
      }
      if (cust && !cust.deleted) {
        name = cust.name || name;
        email = cust.email || email;
      }
    }

    const savedMs = si.created ? si.created * 1000 : null;

    orphans.push({
      setupIntentId: si.id,
      customerId,
      email,
      name,
      source: si.metadata?.source || null,
      sourceLabel: SOURCE_LABEL[si.metadata?.source] || 'card save',
      cardOnFile: Boolean(pmId),
      savedAt: savedMs ? new Date(savedMs).toISOString() : null,
      // Age is the whole story for the owner: a customer waiting six weeks is a
      // different conversation from one waiting an hour.
      ageDays: savedMs ? Math.floor((Date.now() - savedMs) / 86400000) : null,
    });
  }

  orphans.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  return orphans;
}
