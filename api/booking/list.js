import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { computeBookingFinancialSummary } from '../_source-of-truth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { status, limit, offset, bookingId, ref } = req.query;
  const safeLimit  = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  let query = sb
    .from('bookings')
    .select('*, messages(count)', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (status && status !== 'all') query = query.eq('status', status);
  if (bookingId) query = query.eq('id', String(bookingId));
  if (ref) query = query.eq('ref', String(ref).trim());
  query = query.range(safeOffset, safeOffset + safeLimit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('List bookings error:', error);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }

  // Enrich with assembler name/tier/rating — separate query avoids FK constraint uncertainty
  if (data && data.length) {
    const bookingIds = data.map(booking => booking.id);
    const { data: manualPaymentEvents, error: manualPaymentEventsError } = await sb
      .from('owner_manual_payment_events')
      .select('id, booking_id, amount_cents, refunded_cents, latest_refund_id, refunded_at, refund_reason, payment_method, processing_fee_cents, stripe_payment_intent_id, stripe_charge_id, stripe_created_at, booking_total_before_cents, booking_total_after_cents, discount_cents, adjustment_note, payment_note, created_at')
      .in('booking_id', bookingIds)
      .order('created_at', { ascending: true });
    if (manualPaymentEventsError && data.some(booking => booking.source === 'owner_manual')) {
      console.error('Owner manual payment ledger lookup error:', manualPaymentEventsError);
      return res.status(503).json({
        error: 'Owner-manual payment and refund balances cannot be verified. Apply migration 045 and retry.',
        code: 'OWNER_MANUAL_REFUND_LEDGER_UNAVAILABLE',
      });
    }

    const paymentsByBookingId = new Map();
    (manualPaymentEvents || []).forEach(event => {
      if (!paymentsByBookingId.has(event.booking_id)) paymentsByBookingId.set(event.booking_id, []);
      paymentsByBookingId.get(event.booking_id).push(event);
    });

    data.forEach(booking => {
      const paymentEvents = paymentsByBookingId.get(booking.id) || [];
      const ledgerGrossCents = paymentEvents.reduce(
        (sum, event) => sum + Number(event.amount_cents || 0),
        0,
      );
      const ledgerRefundedCents = paymentEvents.reduce(
        (sum, event) => sum + Number(event.refunded_cents || 0),
        0,
      );
      const ledgerProcessingFeeCents = paymentEvents.reduce(
        (sum, event) => sum + Number(event.processing_fee_cents || 0),
        0,
      );
      const ledgerNetCents = Math.max(0, ledgerGrossCents - ledgerRefundedCents);
      const manualStripeRefundableCents = paymentEvents
        .filter(event => ['stripe_manual', 'card_on_site'].includes(event.payment_method))
        .reduce(
          (sum, event) => sum + Math.max(
            0,
            Number(event.amount_cents || 0) - Number(event.refunded_cents || 0),
          ),
          0,
        );
      const legacyCollectedCents = booking.source === 'owner_manual'
        && booking.payment_collected === true
        && paymentEvents.length === 0
        ? Number(booking.amount_charged ?? booking.total_price ?? 0)
        : 0;
      const amountCollectedCents = paymentEvents.length ? ledgerNetCents : legacyCollectedCents;
      booking.payment_events = paymentEvents;
      booking.manual_payment_gross_cents = ledgerGrossCents;
      booking.amount_paid_cents = paymentEvents.length ? ledgerGrossCents : legacyCollectedCents;
      booking.manual_refunded_cents = ledgerRefundedCents;
      booking.manual_stripe_refundable_cents = manualStripeRefundableCents;
      booking.amount_collected_cents = amountCollectedCents;
      booking.remaining_balance_cents = Math.max(
        0,
        Number(booking.total_price || 0) - (paymentEvents.length ? ledgerGrossCents : legacyCollectedCents),
      );
      booking.payment_ledger_legacy = legacyCollectedCents > 0;
      const isOwnerManual = booking.source === 'owner_manual';
      const ownerManualGrossCents = paymentEvents.length ? ledgerGrossCents : legacyCollectedCents;
      booking.financial_summary = computeBookingFinancialSummary({
        // Owner-created bookings must never turn an unpaid total into revenue.
        // Their verified payment ledger (or the audited legacy full-payment
        // flag) is the only customer-money source of truth.
        amountChargedCents: isOwnerManual ? ownerManualGrossCents : booking.amount_charged,
        totalPriceCents: isOwnerManual ? 0 : booking.total_price,
        refundAmountCents: isOwnerManual && paymentEvents.length
          ? ledgerRefundedCents
          : booking.refund_amount,
        taxAmountCents: booking.tax_amount,
        stripeFeeCents: isOwnerManual && paymentEvents.length
          ? ledgerProcessingFeeCents
          : booking.stripe_fee,
        assemblerDueCents: booking.assembler_due,
        payoutAmountCents: booking.payout_amount,
      });
    });

    const aIds = [...new Set(data.filter(b => b.assembler_id).map(b => b.assembler_id))];
    if (aIds.length) {
      const { data: profiles } = await sb
        .from('profiles')
        .select('id, full_name, tier, rating, completed_jobs, phone, payout_method_preference')
        .in('id', aIds);
      if (profiles) {
        const pm = {};
        profiles.forEach(p => { pm[p.id] = p; });
        data.forEach(b => {
          if (b.assembler_id && pm[b.assembler_id]) {
            b.assembler_name  = pm[b.assembler_id].full_name;
            b.assembler_tier  = pm[b.assembler_id].tier;
            b.assembler_rating= pm[b.assembler_id].rating;
            b.assembler_jobs  = pm[b.assembler_id].completed_jobs;
            b.assembler_phone = pm[b.assembler_id].phone || null;
            b.assembler_payout_method_preference = pm[b.assembler_id].payout_method_preference || null;
          }
        });
      }
    }

    // Recipient truth, not sender labels, determines what is unread for the
    // owner. Customer and Easer messages are both operationally important.
    const bIds = bookingIds;
    const { data: unreadMsgs, error: unreadError } = await sb
      .from('messages')
      .select('booking_id, sender')
      .in('booking_id', bIds)
      .eq('recipient_type', 'owner')
      .is('read_at', null);
    if (unreadError) {
      console.error('Unread booking messages lookup error:', unreadError);
      return res.status(503).json({
        error: 'Bookings loaded, but owner message notifications could not be verified. Apply migration 037 and retry.',
        code: 'MESSAGE_NOTIFICATION_TRUTH_UNAVAILABLE',
      });
    }
    if (unreadMsgs && unreadMsgs.length) {
      const unreadByBooking = new Map();
      unreadMsgs.forEach(message => {
        const current = unreadByBooking.get(message.booking_id) || {
          count: 0,
          customer: false,
          assembler: false,
        };
        current.count += 1;
        if (message.sender === 'customer') current.customer = true;
        if (message.sender === 'assembler') current.assembler = true;
        unreadByBooking.set(message.booking_id, current);
      });
      data.forEach(booking => {
        const unread = unreadByBooking.get(booking.id);
        if (!unread) return;
        booking.unread_message_count = unread.count;
        booking.has_unread_customer_msg = unread.customer;
        booking.has_unread_easer_msg = unread.assembler;
      });
    }
  }

  return res.status(200).json({ bookings: data || [], count });
}
