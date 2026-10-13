/**
 * THE Easer's view of their tips (owner audit, 2026-10-12: tips were charged on
 * the Easer's own Stripe account by api/booking/tip.js, but nothing showed them).
 * A tip is not a platform payout and never enters the payout ledger; it is shown
 * beside earnings, as what the customer gave, Stripe's fee, and what the Easer keeps.
 */

const COUNTED = new Set(['succeeded', 'refunded', 'disputed']);

/** What the Easer keeps from one tip, after Stripe's fee and any refund. */
export function tipNetCents(row = {}) {
  const amount = Number(row.amount_cents || 0);
  const refunded = Number(row.refunded_cents || 0);
  const fee = row.stripe_fee_cents == null ? null : Number(row.stripe_fee_cents);
  const net = row.easer_net_cents != null ? Number(row.easer_net_cents) : (fee == null ? amount : amount - fee);
  return Math.max(0, net - refunded);
}

export function summarizeTips(rows = []) {
  const counted = rows.filter(r => COUNTED.has(r.status));
  return {
    count: counted.length,
    amountCents: counted.reduce((sum, r) => sum + Number(r.amount_cents || 0), 0),
    feeCents: counted.reduce((sum, r) => sum + Number(r.stripe_fee_cents || 0), 0),
    refundedCents: counted.reduce((sum, r) => sum + Number(r.refunded_cents || 0), 0),
    netCents: counted.reduce((sum, r) => sum + tipNetCents(r), 0),
    feePending: counted.some(r => r.stripe_fee_cents == null),
  };
}

/** Every tip this Easer has received, newest first, with the job it was for. */
export async function loadEaserTips(sb, easerId) {
  const { data, error } = await sb.from('booking_tips')
    .select('id, booking_id, amount_cents, stripe_fee_cents, easer_net_cents, refunded_cents, status, created_at')
    .eq('easer_id', easerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = data || [];
  const bookingIds = [...new Set(rows.map(r => r.booking_id).filter(Boolean))];
  const refs = new Map();
  if (bookingIds.length) {
    const { data: bookings } = await sb.from('bookings').select('id, ref, service, date').in('id', bookingIds);
    (bookings || []).forEach(b => refs.set(b.id, b));
  }
  return {
    summary: summarizeTips(rows),
    items: rows.filter(r => COUNTED.has(r.status)).map(r => ({
      id: r.id,
      bookingId: r.booking_id,
      ref: refs.get(r.booking_id)?.ref || null,
      service: refs.get(r.booking_id)?.service || null,
      date: refs.get(r.booking_id)?.date || null,
      amountCents: Number(r.amount_cents || 0),
      feeCents: r.stripe_fee_cents == null ? null : Number(r.stripe_fee_cents),
      refundedCents: Number(r.refunded_cents || 0),
      netCents: tipNetCents(r),
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}
