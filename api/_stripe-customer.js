// The one Stripe customer that holds a customer's saved cards: the first
// customer Stripe lists for their email, the same rule api/booking.js and
// api/booking/setup-intent.js use when a booking saves a card. Saved cards in
// the customer app are that customer's cards, so what Account lists is what
// checkout offers.

export function normalizedEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export async function findStripeCustomer(stripe, email) {
  const e = normalizedEmail(email);
  if (!e) return null;
  const existing = await stripe.customers.list({ email: e, limit: 1 });
  return existing.data[0] || null;
}

export async function findOrCreateStripeCustomer(stripe, email, { name, source } = {}) {
  const found = await findStripeCustomer(stripe, email);
  if (found) return found;
  const e = normalizedEmail(email);
  return stripe.customers.create({ email: e, name: name || e, metadata: { source: source || 'customer_account' } });
}
