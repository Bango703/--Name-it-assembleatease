import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  readBalances, summarizeForOwner, isMissingGiftCardTable, isGiftCardsEnabled, isGiftCardsConfigured,
  codeForSession, deliverCard, voidCard,
} from '../_gift-cards.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROW_LIMIT = 1000;
const MIGRATION_MESSAGE = 'Gift cards are not set up yet. Run migration 119 in Supabase, then refresh.';

/**
 * GET  /api/owner/gift-cards                       everything sold, what is still owed
 * POST /api/owner/gift-cards { action:'resend', id } email the code again
 * POST /api/owner/gift-cards { action:'void', id, note } nothing left can be used
 */
export function createOwnerGiftCardsHandler({ getSb = getSupabase, verify = verifyOwner, env = process.env, deliver = deliverCard, voidOne = voidCard } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!verify(req)) return res.status(401).json({ error: 'Unauthorized' });
    const sb = getSb();

    if (req.method === 'GET') {
      const { data: cards, error } = await sb.from('gift_cards').select('*').order('created_at', { ascending: false }).limit(ROW_LIMIT);
      if (error) {
        if (isMissingGiftCardTable(error)) return res.status(200).json({ tableMissing: true, message: MIGRATION_MESSAGE, enabled: isGiftCardsEnabled(env), configured: isGiftCardsConfigured(env) });
        return res.status(503).json({ error: 'Gift cards could not be loaded. Refresh to try again.' });
      }
      let balances;
      try { balances = await readBalances(sb); } catch (balanceError) {
        console.error('[owner-gift-cards] balances failed:', balanceError?.message || balanceError);
        return res.status(503).json({ error: 'Gift card balances could not be read. Refresh to try again.' });
      }
      return res.status(200).json({
        enabled: isGiftCardsEnabled(env),
        configured: isGiftCardsConfigured(env),
        ...summarizeForOwner(cards || [], balances),
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const action = String(req.body?.action || '');
    const id = String(req.body?.id || '');
    if (!UUID.test(id)) return res.status(400).json({ error: 'Choose a card.' });
    const { data: card, error } = await sb.from('gift_cards').select('*').eq('id', id).maybeSingle();
    if (error) return res.status(503).json({ error: 'The card could not be loaded.' });
    if (!card) return res.status(404).json({ error: 'That card was not found.' });

    if (action === 'resend') {
      if (card.status !== 'active') return res.status(409).json({ error: 'This card is void. It cannot be sent.' });
      if (!isGiftCardsConfigured(env)) return res.status(503).json({ error: 'GIFT_CARD_CODE_SECRET is not set, so the code cannot be rebuilt.' });
      const result = await deliver(sb, card, codeForSession(card.stripe_checkout_session_id, env), { resendTag: Date.now().toString(36) });
      if (!result.ok) return res.status(502).json({ error: `The email was not sent: ${result.error}` });
      return res.status(200).json({ ok: true, message: `Sent to ${card.recipient_email}.` });
    }

    if (action === 'void') {
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm before voiding. Nothing left on the card can be used afterwards.' });
      const result = await voidOne(sb, card, `owner voided: ${String(req.body?.note || '').slice(0, 200)}`);
      return res.status(200).json({ ok: true, message: result.alreadyVoid ? 'This card was already void.' : 'Card voided.' });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  };
}

export default createOwnerGiftCardsHandler();
