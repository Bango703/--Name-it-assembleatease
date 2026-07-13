import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { isStripeConnectEnabled, getAssemblerConnectAccount } from '../_stripe-connect.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/release-payouts  — hourly.
 *
 * Releases held Easer payouts via Stripe Connect once the hold window has passed.
 * The hold (PAYOUT_HOLD_HOURS after completion):
 *   - gives a dispute / work-verification window before money leaves, and
 *   - lets the captured booking funds settle pending -> available (Stripe transfers
 *     need AVAILABLE balance, which is why an at-completion transfer fails).
 *
 * Eligible booking: completed, payment captured (not refunded), payout still pending,
 * assembler_due > 0, completed_at older than the hold. On a transfer error (e.g. funds
 * not yet available) the booking stays pending and is retried on the next run.
 */
// Hold window before a payout is released. Defaults to 48h; override with the
// PAYOUT_HOLD_HOURS env var (e.g. set to 0 in test to release immediately).
const PAYOUT_HOLD_HOURS = Number.isFinite(parseFloat(process.env.PAYOUT_HOLD_HOURS))
  ? parseFloat(process.env.PAYOUT_HOLD_HOURS)
  : 48;

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
  if (!isStripeConnectEnabled() || !process.env.STRIPE_SECRET_KEY) {
    await logCron('release-payouts', { status: 'ok', records: 0, duration: Date.now() - t });
    return res.status(200).json({ released: 0, message: 'Connect disabled — payouts handled manually' });
  }

  const sb = getSupabase();
  const cutoff = new Date(Date.now() - PAYOUT_HOLD_HOURS * 3600000).toISOString();

  const { data: due, error } = await sb
    .from('bookings')
    .select('id, ref, assembler_id, assembler_name, assembler_due, completed_at, stripe_payment_intent_id')
    .eq('status', 'completed')
    .eq('payment_status', 'captured')
    .eq('payout_status', 'pending')
    .gt('assembler_due', 0)
    .lt('completed_at', cutoff)
    .limit(25);

  if (error) {
    console.error('release-payouts query error:', error);
    await logCron('release-payouts', { status: 'error', error: error.message, duration: Date.now() - t });
    return res.status(500).json({ error: 'Query failed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let released = 0;
  const releasedRefs = [];

  for (const b of due || []) {
    const connectState = await getAssemblerConnectAccount(sb, b.assembler_id);
    if (!connectState.ok) continue; // Pro hasn't finished bank onboarding — leave pending

    const idem = `transfer-booking-${b.id}`;
    try {
      await writeFinancialAudit(sb, {
        eventType: 'transfer_attempt', eventSource: 'cron_release_payouts',
        bookingId: b.id, paymentIntentId: b.stripe_payment_intent_id, idempotencyKey: idem,
        status: 'processing', metadata: { ref: b.ref, destinationAccount: connectState.accountId, amount: b.assembler_due },
      });

      const transfer = await stripe.transfers.create({
        amount: b.assembler_due,
        currency: 'usd',
        destination: connectState.accountId,
        transfer_group: `booking_${b.id}`,
        metadata: { bookingId: b.id, bookingRef: b.ref, type: 'assembler_payout' },
      }, { idempotencyKey: idem });

      const notes = `Stripe Connect transfer ${transfer.id} created after ${PAYOUT_HOLD_HOURS}h hold; bank payout not yet verified`;
      const { error: transferStateErr } = await sb.from('bookings').update({
        payout_status: 'transferred',
        payout_amount: b.assembler_due,
        payout_notes: notes,
        stripe_transfer_id: transfer.id,
        stripe_destination_account_id: connectState.accountId,
        stripe_transfer_status: 'succeeded',
        stripe_transfer_created_at: new Date().toISOString(),
        stripe_bank_payout_status: 'pending',
      }).eq('id', b.id).eq('payout_status', 'pending');
      if (transferStateErr) throw new Error(`Transfer created but booking state failed: ${transferStateErr.message}`);

      await writeFinancialAudit(sb, {
        eventType: 'transfer_attempt', eventSource: 'cron_release_payouts',
        bookingId: b.id, paymentIntentId: b.stripe_payment_intent_id, idempotencyKey: idem,
        status: 'processed', metadata: {
          ref: b.ref,
          transferId: transfer.id,
          amount: b.assembler_due,
          transferStatus: 'succeeded',
          bankPayoutStatus: 'pending',
        },
      });

      released++;
      releasedRefs.push(b.ref);
    } catch (err) {
      // Most common transient cause: platform balance not yet available. Leave pending; retry next run.
      console.error('release-payouts transfer error for ' + b.ref + ':', err.message);
      await writeFinancialAudit(sb, {
        eventType: 'transfer_attempt', eventSource: 'cron_release_payouts',
        bookingId: b.id, paymentIntentId: b.stripe_payment_intent_id, idempotencyKey: idem,
        status: 'failed', metadata: { ref: b.ref, amount: b.assembler_due }, error: err?.message || 'transfer failed',
      });
    }
  }

  await logCron('release-payouts', { status: 'ok', records: released, duration: Date.now() - t });
  return res.status(200).json({ released, refs: releasedRefs });
}
