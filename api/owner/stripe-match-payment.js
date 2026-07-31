import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { expectedLiveMode, MAX_PAYMENT_CENTS } from './record-manual-payment.js';

// Tap-to-Pay jobs are often reconciled after the workday. Keep the window wide
// enough for next-day owner bookkeeping while still limiting suggestions to a
// small, recent, human-reviewable set.
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const STRIPE_LIST_LIMIT = 100;

function objectId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

function cardSummary(charge) {
  const details = charge?.payment_method_details || {};
  const card = details.card_present || details.card || null;
  const brand = String(card?.brand || '').trim().toLowerCase();
  const last4 = String(card?.last4 || '').trim();
  return {
    cardBrand: brand || null,
    last4: /^\d{4}$/.test(last4) ? last4 : null,
  };
}

function candidateAmountRank(amountCents, remainingBalanceCents, totalCents) {
  if (amountCents === remainingBalanceCents) return 0;
  if (amountCents === totalCents) return 1;
  return 2;
}

export function buildPaymentMatchCandidates({
  intents,
  linkedPaymentIntentIds,
  bookingId,
  remainingBalanceCents,
  totalCents,
  liveMode,
}) {
  const linked = linkedPaymentIntentIds instanceof Set
    ? linkedPaymentIntentIds
    : new Set(linkedPaymentIntentIds || []);

  return (intents || []).flatMap(intent => {
    const paymentIntentId = String(intent?.id || '');
    const charge = intent?.latest_charge;
    const chargePaymentIntentId = objectId(charge?.payment_intent);
    const amountCents = Number(intent?.amount_received);
    const createdSeconds = Number(intent?.created);
    const metadataBookingId = String(intent?.metadata?.bookingId || '').trim();
    const valid = /^pi_[A-Za-z0-9]+$/.test(paymentIntentId)
      && !linked.has(paymentIntentId)
      && intent?.status === 'succeeded'
      && intent?.currency === 'usd'
      && Number.isSafeInteger(amountCents)
      && amountCents > 0
      && amountCents <= MAX_PAYMENT_CENTS
      && Number.isFinite(createdSeconds)
      && (liveMode == null || intent?.livemode === liveMode)
      && (!metadataBookingId || metadataBookingId === bookingId)
      && charge
      && typeof charge === 'object'
      && charge.status === 'succeeded'
      && charge.paid === true
      && charge.captured === true
      && Number(charge.amount_captured ?? charge.amount) === amountCents
      && Number(charge.amount_refunded || 0) === 0
      && charge.refunded !== true
      && charge.disputed !== true
      && (liveMode == null || charge.livemode === liveMode)
      && (!chargePaymentIntentId || chargePaymentIntentId === paymentIntentId);
    if (!valid) return [];

    const createdAt = new Date(createdSeconds * 1000);
    if (!Number.isFinite(createdAt.getTime())) return [];
    const card = cardSummary(charge);
    return [{
      paymentIntentId,
      amountCents,
      createdAt: createdAt.toISOString(),
      cardBrand: card.cardBrand,
      last4: card.last4,
      _rank: candidateAmountRank(amountCents, remainingBalanceCents, totalCents),
      _createdSeconds: createdSeconds,
    }];
  }).sort((a, b) => a._rank - b._rank
    || b._createdSeconds - a._createdSeconds
    || a.paymentIntentId.localeCompare(b.paymentIntentId));
}

export function chooseBestMatchId(candidates, { remainingBalanceCents, totalCents, searchTruncated = false }) {
  if (searchTruncated) return null;
  const exactRemaining = (candidates || []).filter(candidate =>
    candidate.amountCents === remainingBalanceCents);
  if (exactRemaining.length === 1) return exactRemaining[0].paymentIntentId;
  if (exactRemaining.length > 1) return null;

  if (remainingBalanceCents !== totalCents) return null;
  const exactTotal = (candidates || []).filter(candidate =>
    candidate.amountCents === totalCents);
  return exactTotal.length === 1 ? exactTotal[0].paymentIntentId : null;
}

async function loadBooking(sb, { bookingId, ref }) {
  let query = sb.from('bookings')
    .select('id, ref, source, payment_status, total_price');
  query = bookingId ? query.eq('id', bookingId) : query.eq('ref', ref);
  return query.single();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({
      error: 'Automatic Stripe matching is unavailable. Enter the PaymentIntent ID manually.',
      code: 'STRIPE_CONFIGURATION_UNAVAILABLE',
    });
  }

  const bookingId = String(req.query?.bookingId || '').trim();
  const ref = String(req.query?.ref || '').trim().toUpperCase();
  if (!bookingId && !ref) {
    return res.status(400).json({ error: 'bookingId or ref is required' });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingError } = await loadBooking(sb, { bookingId, ref });
  if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.source !== 'owner_manual' || booking.payment_status !== 'offline_recorded') {
    return res.status(409).json({
      error: 'Automatic matching is only available for owner-created offline bookings.',
      code: 'OWNER_MANUAL_BOOKING_REQUIRED',
    });
  }

  const { data: bookingEvents, error: bookingEventsError } = await sb
    .from('owner_manual_payment_events')
    .select('amount_cents, refunded_cents')
    .eq('booking_id', booking.id);
  if (bookingEventsError) {
    console.error('Stripe matcher booking ledger lookup failed:', bookingEventsError);
    return res.status(503).json({
      error: 'Payment history is unavailable. Enter the PaymentIntent ID manually.',
      code: 'OWNER_MANUAL_REFUND_LEDGER_UNAVAILABLE',
    });
  }

  const grossCollectedCents = (bookingEvents || []).reduce(
    (sum, event) => sum + Number(event.amount_cents || 0),
    0,
  );
  const totalCents = Number(booking.total_price || 0);
  // A refund is a financial adjustment, not a new customer invoice. Matching
  // uses original payments toward the agreed total so it never suggests
  // charging the customer again merely because money was refunded.
  const remainingBalanceCents = Math.max(0, totalCents - grossCollectedCents);
  if (remainingBalanceCents <= 0) {
    return res.status(200).json({
      candidates: [],
      bestMatchId: null,
      searchTruncated: false,
      totalCents,
      grossCollectedCents,
      remainingBalanceCents,
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let page;
  try {
    page = await stripe.paymentIntents.list({
      created: { gte: Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS },
      limit: STRIPE_LIST_LIMIT,
      expand: ['data.latest_charge'],
    });
  } catch (stripeError) {
    console.error('Automatic Stripe payment matching failed:', stripeError);
    return res.status(503).json({
      error: 'Stripe matching is temporarily unavailable. Enter the PaymentIntent ID manually.',
      code: 'STRIPE_MATCH_UNAVAILABLE',
    });
  }

  const listedIntents = Array.isArray(page?.data) ? page.data : [];
  const listedIds = listedIntents
    .map(intent => String(intent?.id || ''))
    .filter(id => /^pi_[A-Za-z0-9]+$/.test(id));
  let linkedIds = new Set();
  if (listedIds.length) {
    const { data: linkedEvents, error: linkedEventsError } = await sb
      .from('owner_manual_payment_events')
      .select('stripe_payment_intent_id')
      .in('stripe_payment_intent_id', listedIds);
    if (linkedEventsError) {
      console.error('Stripe matcher linked-payment lookup failed:', linkedEventsError);
      return res.status(503).json({
        error: 'Used Stripe payments could not be verified. Enter the PaymentIntent ID manually.',
        code: 'STRIPE_MATCH_LINKAGE_UNAVAILABLE',
      });
    }
    linkedIds = new Set((linkedEvents || [])
      .map(event => String(event.stripe_payment_intent_id || ''))
      .filter(Boolean));
  }

  const internalCandidates = buildPaymentMatchCandidates({
    intents: listedIntents,
    linkedPaymentIntentIds: linkedIds,
    bookingId: booking.id,
    remainingBalanceCents,
    totalCents,
    liveMode: expectedLiveMode(),
  });
  const searchTruncated = page?.has_more === true;
  const bestMatchId = chooseBestMatchId(internalCandidates, {
    remainingBalanceCents,
    totalCents,
    searchTruncated,
  });
  const candidates = internalCandidates.map(candidate => ({
    paymentIntentId: candidate.paymentIntentId,
    amountCents: candidate.amountCents,
    createdAt: candidate.createdAt,
    cardBrand: candidate.cardBrand,
    last4: candidate.last4,
  }));

  return res.status(200).json({
    candidates,
    bestMatchId,
    searchTruncated,
    totalCents,
    grossCollectedCents,
    remainingBalanceCents,
  });
}
