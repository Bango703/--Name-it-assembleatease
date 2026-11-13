// Easer: price requests on custom jobs (api/booking/_quote-offers.js).
//   GET   the Easer's requests from the last 30 days, newest first
//   POST  {action:'submit', offerId, earningsDollars, hours, crewSize, note}
//   POST  {action:'withdraw', offerId}
// The Easer is taken from the verified token, never the body, and an offer is
// only ever read or written with easer_id = that Easer.

import { requireActiveApprovedEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { loadBookingItems } from '../booking/_booking-items.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { isMissingTableError } from '../_promotions.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';
import {
  QUOTE_OFFER_STATUS,
  customerQuoteForEarnings,
  offerOpenForEaser,
  privateEaserOffersEnabled,
  quoteRequestForEaser,
  validateOfferSubmission,
} from '../booking/_quote-offers.js';
import { quoteAcceptsOffers } from '../booking/_quote-offer-invites.js';

const BOOKING_FIELDS = 'id, ref, service, service_city, service_zip, date, time, quote_offer_scope, selected_quote_offer_id, payment_method_type, status, payment_status, quote_approved_at, stripe_payment_intent_id, stripe_payment_method_id, assembler_id, quote_expires_at';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const access = await requireActiveApprovedEaser(req);
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const { sb, profile } = access;
  const easerId = profile.id;

  if (req.method === 'GET') {
    if (!privateEaserOffersEnabled()) return res.status(200).json({ enabled: false, requests: [] });
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: offers, error } = await sb.from('quote_price_offers')
      .select('id, booking_id, easer_id, status, earnings_cents, hours, crew_size, note, respond_by, submitted_at, invited_at')
      .eq('easer_id', easerId)
      .gte('invited_at', since)
      .order('invited_at', { ascending: false });
    if (error) {
      if (isMissingTableError(error)) return res.status(200).json({ enabled: true, requests: [] });
      console.error('price requests load failed:', error?.message || error);
      return res.status(503).json({ error: 'Price requests could not be loaded. Pull down to try again.' });
    }
    const bookingIds = [...new Set((offers || []).map(o => o.booking_id))];
    const bookings = new Map();
    let items = new Map();
    const jobOffers = new Map();
    if (bookingIds.length) {
      const { data: rows, error: bookingError } = await sb.from('bookings').select(BOOKING_FIELDS).in('id', bookingIds);
      if (bookingError) return res.status(503).json({ error: 'Price requests could not be loaded. Pull down to try again.' });
      (rows || []).forEach(row => bookings.set(row.id, row));
      items = await loadBookingItems(bookingIds, { sb }).catch(() => new Map());
      // Where the customer approved this Easer's price, this Easer's own job
      // offer says whether the job can be accepted now.
      const approvedIds = (offers || [])
        .filter(o => o.status === QUOTE_OFFER_STATUS.SELECTED)
        .map(o => bookings.get(o.booking_id))
        .filter(b => b && b.quote_approved_at && !b.assembler_id)
        .map(b => b.id);
      if (approvedIds.length) {
        const { data: dispatchRows, error: dispatchError } = await sb.from('dispatch_offers')
          .select('booking_id, offer_status, expires_at, created_at')
          .eq('easer_id', easerId)
          .in('booking_id', approvedIds)
          .order('created_at', { ascending: false });
        if (dispatchError) return res.status(503).json({ error: 'Price requests could not be loaded. Pull down to try again.' });
        (dispatchRows || []).forEach(row => { if (!jobOffers.has(row.booking_id)) jobOffers.set(row.booking_id, row); });
      }
    }
    const requests = (offers || [])
      .filter(offer => bookings.has(offer.booking_id))
      .map(offer => quoteRequestForEaser(offer, bookings.get(offer.booking_id), items.get(offer.booking_id) || [], jobOffers.get(offer.booking_id) || null));
    return res.status(200).json({ enabled: true, requests });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!privateEaserOffersEnabled()) return res.status(409).json({ error: 'Price requests are not open right now.' });
  const action = String(req.body?.action || '');
  const offerId = String(req.body?.offerId || '');
  if (!offerId) return res.status(400).json({ error: 'offerId required' });

  const { data: offer, error: offerError } = await sb.from('quote_price_offers')
    .select('id, booking_id, easer_id, status, respond_by, earnings_cents')
    .eq('id', offerId).eq('easer_id', easerId).maybeSingle();
  if (offerError) return res.status(503).json({ error: 'This request could not be read. Try again.' });
  if (!offer) return res.status(404).json({ error: 'This price request was not found.' });
  if (!offerOpenForEaser(offer)) {
    return res.status(409).json({ error: 'This price request is closed.', code: 'PRICE_REQUEST_CLOSED' });
  }
  const { data: booking } = await sb.from('bookings').select(BOOKING_FIELDS).eq('id', offer.booking_id).maybeSingle();
  if (!booking || !quoteAcceptsOffers(booking)) {
    return res.status(409).json({ error: 'This job is no longer taking prices.', code: 'PRICE_REQUEST_CLOSED' });
  }

  const now = new Date().toISOString();
  if (action === 'withdraw') {
    const { data, error } = await sb.rpc('respond_quote_price_offer', { p_offer_id: offer.id, p_easer_id: easerId, p_action: action, p_value: {} });
    if (error || !data) return res.status(409).json({ error: 'This price request changed. Refresh and try again.' });
    return res.status(200).json({ ok: true, status: 'withdrawn' });
  }

  if (action !== 'submit') return res.status(400).json({ error: 'Unknown action' });
  const checked = validateOfferSubmission(req.body);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const { earningsCents, hours, crewSize, note } = checked.value;
  const { data: saved, error } = await sb.rpc('respond_quote_price_offer', {
    p_offer_id: offer.id, p_easer_id: easerId, p_action: action, p_value: checked.value,
  });
  if (error || !saved) {
    if (error) console.error('price offer submit failed:', error?.message || error);
    return res.status(error?.code === '40001' ? 409 : 503).json({ error: 'Your price was not saved. Refresh the request before trying again.' });
  }
  const firstSubmission = saved.firstSubmission === true;

  const priced = customerQuoteForEarnings(earningsCents, { isMember: hasEffectiveEaserMembership(profile) });
  const { data: named } = await sb.from('profiles').select('full_name').eq('id', easerId).maybeSingle();
  const site = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';
  await sendEmail({
    to: ownerEmail(),
    subject: `Easer price ${firstSubmission ? 'received' : 'updated'}: ${booking.ref}`,
    html: `<p><strong>${esc(named?.full_name || 'An Easer')}</strong> ${firstSubmission ? 'sent' : 'updated'} a price for ${esc(booking.ref)} (${esc(booking.service || '')}).</p>
      <p>Easer earns <strong>$${(earningsCents / 100).toFixed(2)}</strong> &middot; ${hours} h &middot; crew of ${crewSize}<br>
      Customer quote would be <strong>$${(priced.totalCents / 100).toFixed(2)}</strong> ($${(priced.subtotalCents / 100).toFixed(2)} + $${(priced.taxCents / 100).toFixed(2)} tax)</p>
      ${note ? `<p>Note: ${esc(note)}</p>` : ''}
      <p><a href="${site}/owner/">Open the quote in the dashboard</a></p>`,
    meta: { bookingId: booking.id, notificationType: 'quote_price_offer_owner', recipientType: 'owner', notificationKey: `quote-price-offer:${offer.id}:${now}` },
  }).catch(e => console.error('price offer owner email failed:', e?.message || e));

  return res.status(200).json({ ok: true, status: 'sent', earningsCents, hours, crewSize });
}
