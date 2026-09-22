import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { guestMutationTokenHash } from '../_payment-security.js';
import { logActivity } from '../booking/_activity.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * POST /api/owner/correct-customer-email — fix an address the customer typed
 * wrong at checkout.
 *
 * Body: { bookingId, email }
 *
 * WHY THIS IS NOT A FIELD ON EDIT BOOKING
 * edit-booking handles date, time, address and service — things that describe
 * the job. The customer's email is not a detail of the job, it is the identity
 * the whole guest side authenticates against:
 *
 *   - the guest mutation token is DERIVED from it, so the tracking link, the
 *     reschedule and the cancel all stop working the moment it changes,
 *   - review links are signed with it,
 *   - AssembleCash balance is keyed by it (migration 025: the ledger stores
 *     customer_email, and assemblecash_available_balance(p_email) reads it).
 *
 * So this endpoint does the one thing a typo needs — point the booking at the
 * right person — and re-derives the token so the links work again. Anything
 * that would MOVE MONEY between two identities is refused.
 *
 * WHAT IT REFUSES
 * A booking with AssembleCash ledger rows. Those credits sit under the address
 * as typed. Changing the booking without moving them strands the customer's
 * balance under an address they do not own — and if the typo happens to be a
 * real person's address, hands it to them. Moving them is a deliberate
 * financial decision with its own locking (migration 037), not a side effect of
 * correcting a spelling.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String(req.body?.bookingId || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return res.status(400).json({ error: 'A valid bookingId is required.' });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const sb = getSupabase();
  const { data: booking, error: loadError } = await sb
    .from('bookings')
    .select('id, ref, customer_email, customer_name, status')
    .eq('id', bookingId)
    .maybeSingle();

  if (loadError) {
    console.error('correct-customer-email load error:', loadError);
    return res.status(503).json({ error: 'The booking could not be read. Nothing was changed.' });
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const previousEmail = String(booking.customer_email || '').trim().toLowerCase();
  if (previousEmail === email) {
    return res.status(200).json({ ok: true, unchanged: true, email });
  }

  // Money keyed to the address as typed. Not ours to move on a spelling fix.
  const { data: credits, error: creditsError } = await sb
    .from('assemblecash_ledger')
    .select('id')
    .eq('booking_id', booking.id)
    .limit(1);
  if (creditsError) {
    console.error('correct-customer-email credits check error:', creditsError);
    return res.status(503).json({ error: 'AssembleCash could not be checked, so nothing was changed.' });
  }
  if (credits?.length) {
    return res.status(409).json({
      error: 'This booking has AssembleCash credit recorded against the current address. Correcting the email here would strand that balance under an address the customer does not own. Move the credit deliberately first.',
      code: 'ASSEMBLECASH_PRESENT',
    });
  }

  // Re-derive the token from the new address in the same write, or the tracking
  // link, reschedule and cancel all stay broken for the corrected customer.
  const { data: updated, error: updateError } = await sb
    .from('bookings')
    .update({
      customer_email: email,
      guest_mutation_token_hash: guestMutationTokenHash({ id: booking.id, ref: booking.ref, customer_email: email }),
    })
    .eq('id', booking.id)
    .eq('customer_email', booking.customer_email)
    .select('id, ref')
    .maybeSingle();

  if (updateError || !updated) {
    console.error('correct-customer-email update error:', updateError);
    return res.status(409).json({ error: 'The booking changed before this could be saved. Reload and try again.' });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'customer_email_corrected',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Customer email corrected from ${previousEmail || '(none)'} to ${email}. Older links sent to the previous address no longer work.`,
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    email,
    previousEmail: previousEmail || null,
    ref: updated.ref,
    // The owner's next move is almost always to send them their details.
    resendRecommended: true,
  });
}
