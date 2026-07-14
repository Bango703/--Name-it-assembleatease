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
    data.forEach(booking => {
      booking.financial_summary = computeBookingFinancialSummary({
        amountChargedCents: booking.amount_charged,
        totalPriceCents: booking.total_price,
        refundAmountCents: booking.refund_amount,
        taxAmountCents: booking.tax_amount,
        stripeFeeCents: booking.stripe_fee,
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
    const bIds = data.map(b => b.id);
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
