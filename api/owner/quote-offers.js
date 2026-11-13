// Owner: Easer price offers on a custom quote.
//   GET  ?bookingId=   the offers, each with the customer quote it would make
//   POST {action:'invite', bookingId}  ask the Easers who cover the area
//   POST {action:'close',  bookingId}  stop taking prices on this quote
// Pricing the quote from an offer is POST /api/owner/quote-approve with
// quoteOfferId, so a quote has one way to be sent.

import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { privateEaserOffersEnabled, QUOTE_OFFER_STATUS, scrubContactDetails } from '../booking/_quote-offers.js';
import { loadQuoteOffersForOwner, inviteEasersForQuote, quoteAcceptsOffers, listAskableEasers, askableEaserView } from '../booking/_quote-offer-invites.js';
import { logActivity } from '../booking/_activity.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();
  const enabled = privateEaserOffersEnabled();

  if (req.method === 'GET') {
    const bookingId = String(req.query?.bookingId || '');
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    try {
      const result = await loadQuoteOffersForOwner(sb, bookingId);
      // A starting point for the work description Easers see: the customer's
      // request with contact details removed. The owner edits it before asking.
      const { data: asked } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
      const suggestedScope = scrubContactDetails(typeof asked?.details === 'string' ? asked.details : '').slice(0, 2000);
      // Who the owner can ask, decided here (the dispatch eligibility rule),
      // so the list the owner ticks is the list the server will accept.
      let askable = { easers: [], room: 0, message: null };
      if (enabled && asked && quoteAcceptsOffers(asked) && !result.migrationNeeded) {
        askable = await listAskableEasers(sb, asked).catch(err => {
          console.error('askable Easers lookup failed:', err?.message || err);
          return { easers: [], room: 0, message: 'The Easers who cover this area could not be loaded. Refresh to try again.' };
        });
      }
      return res.status(200).json({
        enabled, ...result, suggestedScope,
        workDescription: asked?.quote_offer_scope || null,
        askableEasers: askable.easers.map(askableEaserView),
        askRoom: askable.room,
        askMessage: askable.message,
      });
    } catch (error) {
      console.error('quote offers load failed:', error?.message || error);
      return res.status(503).json({ error: 'Easer offers could not be loaded. Refresh to try again.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const action = String(req.body?.action || '');
  const bookingId = String(req.body?.bookingId || '');
  if (!bookingId) return res.status(400).json({ error: 'bookingId required' });

  const { data: booking, error } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
  if (error) return res.status(503).json({ error: 'The booking could not be read. Try again.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (action === 'invite') {
    if (!enabled) {
      return res.status(409).json({ error: 'Easer price offers are switched off (PRIVATE_EASER_OFFERS_ENABLED).', code: 'QUOTE_OFFERS_DISABLED' });
    }
    if (!quoteAcceptsOffers(booking)) {
      return res.status(409).json({ error: 'Only a custom quote that is waiting for a price can take Easer prices.', code: 'QUOTE_NOT_OPEN' });
    }
    try {
      if (!booking.quote_offer_scope) {
        const scope = String(req.body?.scope || '').trim();
        if (scope.length < 10 || scope.length > 2000) return res.status(400).json({ error: 'Write a work description of 10 to 2,000 characters without customer names, contact details, addresses or access codes.' });
        const { data: scoped, error: scopeError } = await sb.from('bookings')
          .update({ quote_offer_scope: scope }).eq('id', booking.id)
          .is('quote_offer_scope', null).is('selected_quote_offer_id', null).select('id');
        if (scopeError || !scoped?.length) return res.status(409).json({ error: 'The quote changed. Refresh before asking for prices.' });
        booking.quote_offer_scope = scope;
      }
      const rawIds = req.body?.easerIds;
      if (rawIds != null && (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 8
          || rawIds.some(id => !/^[0-9a-f-]{36}$/i.test(String(id))))) {
        return res.status(400).json({ error: 'Choose at least one Easer to ask.' });
      }
      const result = await inviteEasersForQuote(sb, booking, { easerIds: rawIds ?? null });
      if (!result.invited) return res.status(409).json({ error: result.message, code: 'NO_EASERS_TO_ASK' });
      return res.status(200).json({ ok: true, invited: result.invited, notified: result.notified, respondBy: result.respondBy });
    } catch (inviteError) {
      console.error('quote offer invite failed:', inviteError?.message || inviteError);
      const missing = inviteError?.code === '42P01' || /quote_price_offers/.test(String(inviteError?.message || ''));
      return res.status(missing ? 409 : 503).json({
        error: missing ? 'Run migration 129 before asking Easers for prices.' : 'Easers could not be asked. Try again.',
        code: missing ? 'MIGRATION_129_REQUIRED' : 'QUOTE_OFFER_INVITE_FAILED',
      });
    }
  }

  if (action === 'close') {
    const now = new Date().toISOString();
    const { data: closed, error: closeError } = await sb.from('quote_price_offers')
      .update({ status: QUOTE_OFFER_STATUS.CLOSED, decided_at: now, updated_at: now })
      .eq('booking_id', bookingId)
      .in('status', [QUOTE_OFFER_STATUS.INVITED, QUOTE_OFFER_STATUS.SUBMITTED])
      .select('id');
    if (closeError) return res.status(503).json({ error: 'Offers could not be closed. Try again.' });
    await logActivity(sb, { bookingId, eventType: 'quote_offers_closed', actorType: 'owner', actorName: 'Owner', description: `Stopped taking Easer prices (${closed?.length || 0} closed)` });
    return res.status(200).json({ ok: true, closed: closed?.length || 0 });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
