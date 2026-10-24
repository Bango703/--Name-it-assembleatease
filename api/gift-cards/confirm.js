import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import {
  isGiftCardsConfigured, issueFromCheckoutSession, isOurSession, isMissingGiftCardTable,
  formatCents, productName,
} from '../_gift-cards.js';

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(user.length - 1, 6)))}@${domain}`;
}

/**
 * POST /api/gift-cards/confirm  { sessionId }
 * Called by the success page. Asks Stripe whether the session is paid, then
 * issues and emails the card. Safe to repeat; the reconcile cron does the
 * same for any buyer who closed the page early. Works while sales are
 * switched off so a card already paid for is always delivered.
 */
export function createGiftCardConfirmHandler({
  env = process.env,
  getSb = getSupabase,
  stripeFactory = (key) => new Stripe(key),
  issue = issueFromCheckoutSession,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!SESSION_ID.test(sessionId)) return res.status(400).json({ error: 'This confirmation link is not valid.' });
    if (!isGiftCardsConfigured(env)) return res.status(503).json({ error: 'Your payment went through. Your card will arrive by email shortly.' });

    let session;
    try {
      session = await stripeFactory(env.STRIPE_SECRET_KEY).checkout.sessions.retrieve(sessionId);
    } catch (error) {
      if (error?.code === 'resource_missing') return res.status(404).json({ error: 'This purchase was not found.' });
      console.error('[gift-cards] confirm retrieve failed:', error?.message || error);
      return res.status(502).json({ error: 'Your purchase could not be checked right now. If you paid, your card will arrive by email shortly.' });
    }
    if (!isOurSession(session)) return res.status(404).json({ error: 'This purchase was not found.' });
    if (session.payment_status !== 'paid') {
      return res.status(409).json({ error: 'Payment is not complete yet. If you were charged, your card will arrive by email shortly.' });
    }

    try {
      const result = await issue(getSb(), session, { env });
      if (!result.ok) {
        return res.status(409).json({ error: 'Your payment went through. We are checking it and will email your card shortly.' });
      }
      const card = result.card;
      return res.status(200).json({
        ok: true,
        kind: card.kind,
        name: productName(card.kind),
        amount: formatCents(card.paid_cents + card.bonus_cents),
        last4: card.code_last4,
        sentTo: maskEmail(card.recipient_email),
        emailed: result.delivery?.ok !== false,
      });
    } catch (error) {
      if (isMissingGiftCardTable(error)) console.error('[gift-cards] migration 119 is not applied');
      console.error('[gift-cards] confirm issue failed:', error?.message || error);
      return res.status(503).json({ error: 'Your payment went through. Your card will arrive by email shortly.' });
    }
  };
}

export default createGiftCardConfirmHandler();
