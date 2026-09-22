import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';

/**
 * POST /api/owner/mark-test-booking — owner marks one booking as internal, or
 * puts it back.
 *
 * Body: { bookingId, isTest }
 *
 * WHY THIS EXISTS
 * `is_test_booking` decides whether a booking counts as business: the summary
 * emails, the owner board, financials and market demand all read it. Until now
 * NOTHING in the application could write it — migration 094 set six rows by ref
 * and that was the only way it had ever been set. Every test booking made since
 * has counted as real revenue and real demand, and the only remedy was hand-
 * written SQL. Article 9 says the owner should never need database access to
 * run the business.
 *
 * FLAGGED, NEVER DELETED
 * This sets a boolean and nothing else. The row keeps its payment intents,
 * financial audit entries and notification history, which is what migration 094
 * decided when it refused to delete them (Articles 6 and 15). It is reversible
 * in one call, and every flip is written to the booking timeline with who did
 * it, so a number that moves can always be explained.
 *
 * WHAT IT REFUSES
 * A booking that moved real money. Marking one of those as a test would quietly
 * remove settled revenue from the owner's own figures — the exact class of
 * silent inaccuracy the flag exists to prevent. Unmarking is always allowed:
 * putting a booking back into the business can only ever be corrective.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String(req.body?.bookingId || '').trim();
  const isTest = req.body?.isTest;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return res.status(400).json({ error: 'A valid bookingId is required.' });
  }
  if (typeof isTest !== 'boolean') {
    return res.status(400).json({ error: 'isTest must be true or false.' });
  }

  const sb = getSupabase();
  const { data: booking, error: loadError } = await sb
    .from('bookings')
    .select('id, ref, customer_name, status, is_test_booking, amount_charged, payout_amount, paid_out_at, stripe_transfer_id')
    .eq('id', bookingId)
    .maybeSingle();

  if (loadError) {
    console.error('mark-test-booking load error:', loadError);
    return res.status(503).json({ error: 'The booking could not be read. Nothing was changed.' });
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  if (booking.is_test_booking === isTest) {
    return res.status(200).json({ ok: true, unchanged: true, isTest, ref: booking.ref });
  }

  if (isTest) {
    const settledMoney = Number(booking.amount_charged || 0) > 0
      || Number(booking.payout_amount || 0) > 0
      || !!booking.paid_out_at
      || !!booking.stripe_transfer_id;
    if (settledMoney) {
      return res.status(409).json({
        error: 'This booking moved real money, so it cannot be marked as a test. Marking it would remove settled revenue from your own figures.',
      });
    }
  }

  // Compare-and-set: if the flag changed under us, say so rather than clobber.
  const { data: updated, error: updateError } = await sb
    .from('bookings')
    .update({ is_test_booking: isTest })
    .eq('id', bookingId)
    .eq('is_test_booking', booking.is_test_booking === true)
    .select('id, ref')
    .maybeSingle();

  if (updateError || !updated) {
    console.error('mark-test-booking update error:', updateError);
    return res.status(409).json({ error: 'The booking changed before this could be saved. Reload and try again.' });
  }

  await logActivity(sb, {
    bookingId,
    eventType: isTest ? 'booking_marked_test' : 'booking_marked_real',
    actorType: 'owner',
    actorName: 'Owner',
    description: isTest
      ? 'Marked as an internal test booking — excluded from business figures, still on the record'
      : 'Put back into the business — counted in every figure again',
  }).catch(() => {});

  return res.status(200).json({ ok: true, isTest, ref: updated.ref });
}
