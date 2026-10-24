import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { logCron } from './_cron-logger.js';
import {
  isGiftCardsConfigured, isOurSession, issueFromCheckoutSession, codeForSession, deliverCard,
  voidCard, readBalances, alertOwner, isMissingGiftCardTable, formatCents,
} from '../_gift-cards.js';

const LOOKBACK_SECONDS = 3 * 24 * 60 * 60;
const MAX_PAGES = 5;
const STUCK_DELIVERY_MS = 2 * 60 * 60 * 1000;

async function listAll(listFn, params) {
  const rows = [];
  let startingAfter;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listFn({ ...params, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    rows.push(...(result?.data || []));
    if (!result?.has_more || !result.data?.length) break;
    startingAfter = result.data[result.data.length - 1].id;
  }
  return rows;
}

function paymentIntentOf(obj) {
  return (typeof obj?.payment_intent === 'string' ? obj.payment_intent : obj?.payment_intent?.id) || null;
}

/**
 * GET /api/cron/gift-cards-reconcile (hourly)
 * 1. Any paid gift card checkout without a card gets its card (buyer closed the page).
 * 2. Any card whose email failed is sent again.
 * 3. A refunded purchase voids its card when none of it was used; a dispute,
 *    or a refund on a card already partly used, is sent to the owner.
 * The Stripe webhook is not involved; Stripe is read directly.
 */
export function createGiftCardReconcileHandler({
  env = process.env,
  getSb = getSupabase,
  stripeFactory = (key) => new Stripe(key),
  issue = issueFromCheckoutSession,
  deliver = deliverCard,
  voidOne = voidCard,
  alert = alertOwner,
  log = logCron,
  nowSeconds = () => Math.floor(Date.now() / 1000),
} = {}) {
  return async function handler(req, res) {
    const secret = req.headers['authorization']?.replace('Bearer ', '');
    if (!env.CRON_SECRET || secret !== env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const started = Date.now();
    if (!isGiftCardsConfigured(env)) {
      await log('gift-cards-reconcile', { status: 'ok', records: 0, duration: Date.now() - started });
      return res.status(200).json({ ok: true, skipped: 'not_configured' });
    }
    const sb = getSb();
    const stripe = stripeFactory(env.STRIPE_SECRET_KEY);
    const since = nowSeconds() - LOOKBACK_SECONDS;
    const out = { issued: 0, redelivered: 0, voided: 0, flagged: 0, errors: [] };

    try {
      const { error: tableError } = await sb.from('gift_cards').select('id').limit(1);
      if (tableError) {
        if (isMissingGiftCardTable(tableError)) {
          await log('gift-cards-reconcile', { status: 'ok', records: 0, duration: Date.now() - started });
          return res.status(200).json({ ok: true, skipped: 'migration_119_not_applied' });
        }
        throw tableError;
      }

      // 1. Paid sessions with no card yet.
      const sessions = (await listAll((p) => stripe.checkout.sessions.list(p), { created: { gte: since } }))
        .filter((s) => isOurSession(s) && s.payment_status === 'paid');
      if (sessions.length) {
        const { data: existing, error } = await sb.from('gift_cards').select('stripe_checkout_session_id')
          .in('stripe_checkout_session_id', sessions.map((s) => s.id));
        if (error) throw error;
        const have = new Set((existing || []).map((r) => r.stripe_checkout_session_id));
        for (const session of sessions.filter((s) => !have.has(s.id))) {
          try {
            const result = await issue(sb, session, { env });
            if (result.ok) out.issued += 1;
          } catch (error) { out.errors.push(`issue ${session.id}: ${error?.message || error}`); }
        }
      }

      // 2. Cards whose email never went out.
      const { data: undelivered, error: undeliveredError } = await sb.from('gift_cards').select('*')
        .eq('status', 'active').is('delivered_at', null).limit(50);
      if (undeliveredError) throw undeliveredError;
      for (const card of undelivered || []) {
        try {
          const result = await deliver(sb, card, codeForSession(card.stripe_checkout_session_id, env));
          if (result.ok && !result.skipped) out.redelivered += 1;
          if (!result.ok && Date.now() - new Date(card.created_at).getTime() > STUCK_DELIVERY_MS) {
            await alert('A gift card email has not gone out', {
              card: `${card.kind} ending ${card.code_last4}`,
              to: card.recipient_email,
              error: result.error,
              action: 'Check the address, then use Resend code in Gift Cards.',
            }, { key: `undelivered:${card.id}` });
            out.flagged += 1;
          }
        } catch (error) { out.errors.push(`deliver ${card.id}: ${error?.message || error}`); }
      }

      // 3. Refunds and disputes on gift card purchases.
      const refunds = await listAll((p) => stripe.refunds.list(p), { created: { gte: since } });
      const disputes = await listAll((p) => stripe.disputes.list(p), { created: { gte: since } });
      const touched = new Map();
      for (const r of refunds) {
        const pi = paymentIntentOf(r);
        if (pi && r.status === 'succeeded') touched.set(pi, { ...(touched.get(pi) || {}), refund: true });
      }
      for (const d of disputes) {
        const pi = paymentIntentOf(d);
        if (pi) touched.set(pi, { ...(touched.get(pi) || {}), dispute: d.id });
      }
      if (touched.size) {
        const { data: cards, error } = await sb.from('gift_cards').select('*')
          .in('stripe_payment_intent_id', [...touched.keys()]).eq('status', 'active');
        if (error) throw error;
        const balances = cards?.length ? await readBalances(sb) : new Map();
        for (const card of cards || []) {
          const what = touched.get(card.stripe_payment_intent_id);
          const balance = balances.get(card.id) || { paidCents: 0, bonusCents: 0 };
          const unused = balance.paidCents === card.paid_cents;
          try {
            if (what.refund && !what.dispute && unused) {
              let pi = null;
              try {
                pi = await stripe.paymentIntents.retrieve(card.stripe_payment_intent_id, { expand: ['latest_charge'] });
              } catch (error) {
                pi = null;
              }
              const charge = pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
              if (charge && Number(charge.amount_refunded) >= Number(charge.amount)) {
                await voidOne(sb, card, 'purchase refunded in full');
                out.voided += 1;
                continue;
              }
            }
            await alert(what.dispute ? 'A gift card purchase is disputed' : 'A gift card purchase was refunded', {
              card: `${card.kind} ending ${card.code_last4}`,
              purchaser: card.purchaser_email,
              paid: formatCents(card.paid_cents),
              left: formatCents(balance.paidCents + balance.bonusCents),
              dispute: what.dispute || null,
              action: 'Open Gift Cards and void the card if it should no longer be used.',
            }, { key: `${what.dispute ? 'dispute' : 'refund'}:${card.id}` });
            out.flagged += 1;
          } catch (error) { out.errors.push(`refund ${card.id}: ${error?.message || error}`); }
        }
      }

      const records = out.issued + out.redelivered + out.voided + out.flagged;
      await log('gift-cards-reconcile', {
        status: out.errors.length ? 'error' : 'ok', records, duration: Date.now() - started,
        error: out.errors.length ? out.errors.slice(0, 5).join(' | ') : null,
      });
      return res.status(200).json({ ok: out.errors.length === 0, ...out });
    } catch (error) {
      await log('gift-cards-reconcile', { status: 'error', error: error?.message || String(error), duration: Date.now() - started });
      console.error('[gift-cards-reconcile]', error?.message || error);
      return res.status(500).json({ error: 'Gift card reconcile failed' });
    }
  };
}

export default createGiftCardReconcileHandler();
