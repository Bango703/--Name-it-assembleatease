import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';

/**
 * DELETE /api/booking/delete
 * Owner only: hard-delete a cancelled or declined booking.
 * Body: { bookingId } or { ref }
 * Only bookings with status 'cancelled' or 'declined' may be deleted.
 */
export default async function handler(req, res) {
  if (req.method !== 'DELETE' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (process.env.VERCEL_ENV === 'production' || String(process.env.ENABLE_TEST_ENDPOINTS || '').toLowerCase() !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

  const body = req.method === 'DELETE' ? req.body : req.body;
  const { bookingId, ref, confirm } = body || {};
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });
  if (confirm !== 'DELETE_ZERO_VALUE_SIMULATION') {
    return res.status(400).json({ error: 'Explicit simulation deletion confirmation is required' });
  }

  const sb = getSupabase();
  const now = new Date().toISOString();

  let query = sb.from('bookings').select('id, status, ref, customer_name, customer_email, service, date, time, cancel_reason, cancellation_fee, payment_status, total_price, amount_charged, refund_amount, payout_amount, assembler_id, stripe_payment_intent_id, stripe_transfer_id');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  const deletable = [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.DECLINED];
  if (!deletable.includes(booking.status)) {
    return res.status(400).json({ error: 'Only cancelled or declined bookings can be deleted' });
  }
  const isSimulation = String(booking.customer_name || '').startsWith('SIM-');
  const hasFinancialOrAssignmentState = !!(
    Number(booking.total_price || 0)
    || Number(booking.amount_charged || 0)
    || Number(booking.refund_amount || 0)
    || Number(booking.payout_amount || 0)
    || booking.assembler_id
    || booking.stripe_payment_intent_id
    || booking.stripe_transfer_id
  );
  if (!isSimulation || hasFinancialOrAssignmentState || !['not_required', 'pending'].includes(String(booking.payment_status || 'pending'))) {
    return res.status(409).json({ error: 'Only zero-value, unassigned SIM- records can be hard-deleted' });
  }

  // Durable pre-delete audit row. notification_log uses ON DELETE SET NULL,
  // so this record survives even after the booking row is removed.
  let auditLogged = false;
  try {
    const auditDetail = {
      action: 'booking_deleted',
      deletedAt: now,
      actor: 'owner',
      bookingRef: booking.ref,
      status: booking.status,
      customerName: booking.customer_name || null,
      customerEmail: booking.customer_email || null,
      service: booking.service || null,
      date: booking.date || null,
      time: booking.time || null,
      cancelReason: booking.cancel_reason || null,
      cancellationFee: booking.cancellation_fee || null,
      paymentStatus: booking.payment_status || null,
    };
    const { error: auditErr } = await sb.from('notification_log').insert({
      booking_id: booking.id,
      channel: 'system',
      notification_type: 'booking_deleted',
      recipient_type: 'owner',
      recipient_email: null,
      recipient_user_id: null,
      subject: `Booking deleted: ${booking.ref}`,
      status: 'sent',
      provider_id: null,
      error_text: JSON.stringify(auditDetail),
      sent_at: now,
    });
    if (!auditErr) auditLogged = true;
    else console.error('Booking delete audit insert error:', auditErr);
  } catch (auditEx) {
    console.error('Booking delete audit exception:', auditEx);
  }

  const { error: deleteErr } = await sb
    .from('bookings')
    .delete()
    .eq('id', booking.id);

  if (deleteErr) {
    console.error('Booking delete error:', deleteErr);
    return res.status(500).json({ error: 'Failed to delete booking' });
  }

  console.log(JSON.stringify({
    audit: true,
    action: 'booking_delete',
    actor: 'owner',
    bookingId: booking.id,
    ref: booking.ref,
    status: booking.status,
    auditLogged,
    timestamp: now,
  }));

  return res.status(200).json({ ok: true, deleted: booking.ref, auditLogged });
}
