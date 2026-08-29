import { getSupabase } from '../_supabase.js';
import { loadBookingItems, countAddOns } from './_booking-items.js';
import { loadChangeOrders, summarizeChangeOrders, changeOrderEligibility } from './_change-orders.js';
import { loadCrew, summarizeCrew } from './_crew.js';
import { describeArrival } from '../_geocode.js';
import { verifyOwner } from '../_email.js';
import {
  allocateCollectedTaxCents,
  computeBookingFinancialSummary,
} from '../_source-of-truth.js';

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
        taxAmountCents: isOwnerManual && paymentEvents.length
          ? allocateCollectedTaxCents({
            invoiceTotalCents: booking.total_price,
            invoiceTaxCents: booking.tax_amount,
            grossCollectedCents: ledgerGrossCents,
          })
          : booking.tax_amount,
        stripeFeeCents: isOwnerManual && paymentEvents.length
          ? ledgerProcessingFeeCents
          : booking.stripe_fee,
        assemblerDueCents: booking.assembler_due,
        payoutAmountCents: booking.payout_amount,
        easerBonusCents: booking.easer_bonus_cents,
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
    // The owner must see exactly the scope the customer bought and the Easer
    // will be shown — including add-ons. Without this the owner priced quotes
    // blind while the Easer had the full list.
    try {
      const itemsByBooking = await loadBookingItems(bookingIds, { sb, includePricing: true });
      data.forEach(booking => {
        const groups = itemsByBooking.get(booking.id) || [];
        booking._booking_items = groups;
        booking._add_on_count = countAddOns(groups);
      });
    } catch (itemsError) {
      console.error('Owner booking-items lookup error:', itemsError);
      // Null (not []) so the dashboard can say "could not load" rather than
      // silently render an empty scope that looks like "no add-ons".
      data.forEach(booking => { booking._booking_items = null; booking._add_on_count = null; });
    }

    // Arrival verification, decided HERE and rendered there. The thresholds and
    // the accuracy weighting are one rule in one module (Article 4) — the owner
    // dashboard must not grow a second opinion about what "at the address" means.
    data.forEach(booking => {
      booking._arrival = booking.checked_in_at
        ? describeArrival({
            distanceM: booking.arrived_distance_m,
            accuracyM: booking.arrived_accuracy_m,
          })
        : null;
    });

    // Who else is on each job, and what each person is owed. Read through the one
    // crew loader so the owner panel and the Easer dashboard can never disagree
    // about a split. Optional enrichment, exactly like change orders below: a
    // crew lookup fault must not degrade a booking whose money is perfectly fine.
    try {
      const crewByBooking = await loadCrew(bookingIds, { sb });
      // Names are resolved here rather than joined in SQL so the loader stays a
      // pure crew reader and this stays the only place that needs profiles.
      const crewEaserIds = [...new Set([...crewByBooking.values()].flat().map(c => c.easer_id))];
      const namesById = new Map();
      if (crewEaserIds.length) {
        const { data: profs } = await sb.from('profiles').select('id, full_name').in('id', crewEaserIds);
        for (const pr of profs || []) namesById.set(pr.id, pr.full_name);
      }
      data.forEach(booking => {
        const rows = (crewByBooking.get(booking.id) || []).map(c => ({
          ...c, easer_name: namesById.get(c.easer_id) || 'Easer',
        }));
        booking._crew = rows;
        booking._crew_summary = summarizeCrew(rows);
      });
    } catch (crewError) {
      console.error('[list] crew load failed:', crewError?.message || crewError);
      data.forEach(booking => { booking._crew = []; });
    }

    // Approved change orders change what the customer owes and what the Easer is
    // paid on, so the owner must see them on the booking, not only in Stripe.
    try {
      const ordersByBooking = await loadChangeOrders(bookingIds, { sb });
      data.forEach(booking => {
        const rows = ordersByBooking.get(booking.id) || [];
        booking._change_orders = rows;
        booking._change_order_summary = summarizeChangeOrders(rows);
        const eligible = changeOrderEligibility(booking);
        booking._change_order_eligible = eligible.ok;
        booking._change_order_blocked_reason = eligible.ok ? null : eligible.reason;
      });
    } catch (changeOrderError) {
      // Change orders are an OPTIONAL enrichment. The booking, its money, its
      // items and its Easer are all loaded and correct; only the extras lookup
      // failed. Degrading the whole booking view over it — a red "totals may be
      // incomplete" on every job — is worse than the failure itself, and reads
      // as data loss on records that are perfectly fine.
      //
      // A first attempt tried to classify WHY it failed (missing table vs real
      // error) and still showed red for the "real" case. That was the same
      // mistake twice: guessing at error codes, and letting a backend problem
      // shout from a place the owner cannot act on. A backend failure belongs in
      // the platform-errors panel, which is exactly where console.error puts it.
      console.error('Change-order lookup error:', changeOrderError?.message || changeOrderError);
      data.forEach(booking => {
        booking._change_orders = [];
        booking._change_order_summary = { count: 0, rows: [], billableTotalCents: 0, billableTaxCents: 0, capturedTotalCents: 0, refundedCents: 0, pendingTotalCents: 0, pendingCount: 0, openCount: 0 };
        // The one place it DOES surface is the control the owner would reach for,
        // stated plainly instead of as an alarm.
        booking._change_order_eligible = false;
        booking._change_order_blocked_reason = 'Additional work is unavailable right now.';
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
