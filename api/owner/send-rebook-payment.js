import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { randomToken, sha256 } from '../_payment-security.js';
import { logActivity } from '../booking/_activity.js';
import { sendRebookPaymentEmail } from '../booking/_rebook-payment-email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error } = await sb.from('bookings')
    .select('id, ref, service, status, payment_status, customer_name, customer_email, address, date, time, details, total_price, tax_amount, source, rebooked_from_booking_id, guest_mutation_token_hash, stripe_payment_intent_id, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at, cancellation_reconciliation_required_at')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) return res.status(503).json({ error: 'Rebooking state could not be verified.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.source !== 'online' || !booking.rebooked_from_booking_id) {
    return res.status(409).json({ error: 'Only an owner-prepared replacement appointment can use this email.' });
  }
  if (booking.status !== 'pending' || booking.payment_status !== 'pending') {
    return res.status(409).json({ error: 'This replacement appointment is not awaiting a customer payment method.' });
  }
  if (!booking.customer_email) return res.status(409).json({ error: 'Add a valid customer email before sending the payment link.' });
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at
      || booking.financial_reconciliation_required_at || booking.cancellation_reconciliation_required_at) {
    return res.status(409).json({ error: 'Another payment or cancellation action is in progress. Try again after it finishes.' });
  }

  const priorHash = booking.guest_mutation_token_hash || null;
  const token = randomToken(32);
  const nextHash = sha256(token);
  let rotation = sb.from('bookings').update({ guest_mutation_token_hash: nextHash })
    .eq('id', booking.id)
    .eq('status', 'pending')
    .eq('payment_status', 'pending')
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null)
    .is('cancellation_reconciliation_required_at', null);
  rotation = priorHash
    ? rotation.eq('guest_mutation_token_hash', priorHash)
    : rotation.is('guest_mutation_token_hash', null);
  const { data: rows, error: rotationError } = await rotation.select('id');
  if (rotationError || !rows?.length) {
    return res.status(rotationError ? 503 : 409).json({ error: 'A fresh secure payment link could not be saved. Refresh and try again.' });
  }

  const emailResult = await sendRebookPaymentEmail({ booking, token })
    .catch(emailError => ({ ok: false, error: emailError?.message || String(emailError) }));
  const delivered = emailResult?.ok === true && emailResult?.suppressed !== true;
  let rollbackFailed = false;
  if (!delivered) {
    let rollback = sb.from('bookings').update({ guest_mutation_token_hash: priorHash })
      .eq('id', booking.id)
      .eq('status', 'pending')
      .eq('payment_status', 'pending')
      .eq('guest_mutation_token_hash', nextHash)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null)
      .is('financial_reconciliation_required_at', null)
      .is('cancellation_reconciliation_required_at', null);
    const { data: rollbackRows, error: rollbackError } = await rollback.select('id');
    rollbackFailed = !!rollbackError || !rollbackRows?.length;
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: delivered ? 'rebook_payment_email_sent' : 'rebook_payment_email_failed',
    actorType: 'owner',
    actorName: 'Owner',
    description: delivered
      ? 'Owner sent a fresh secure payment-method link for the replacement appointment.'
      : 'The replacement payment-method email was not confirmed delivered.',
    metadata: {
      emailError: emailResult?.error || null,
      priorTokenRestored: !delivered && !rollbackFailed,
      tokenRollbackFailed: rollbackFailed,
    },
  }).catch(() => {});

  if (!delivered) {
    return res.status(502).json({
      error: rollbackFailed
        ? 'The email failed and customer-link state needs review before retrying.'
        : 'The email was not accepted. The prior customer link remains valid.',
      code: rollbackFailed ? 'REBOOK_EMAIL_TOKEN_ROLLBACK_FAILED' : 'REBOOK_PAYMENT_EMAIL_FAILED',
    });
  }
  return res.status(200).json({ ok: true, bookingId: booking.id, ref: booking.ref });
}
