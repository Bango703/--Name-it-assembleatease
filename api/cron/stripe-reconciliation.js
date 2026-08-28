import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/stripe-reconciliation — daily at 11:00 UTC.
 *
 * WHY THIS EXISTS
 * Every other guard in this repo is a static test: it reads code and fails a
 * build. None of them can catch a DATA condition — a row that quietly stopped
 * agreeing with Stripe. Two of those shipped and survived for months:
 *
 *   AAE-MPBUPWVA   DB said captured $153.00   Stripe said $0.00 received
 *                  (the booking referenced an abandoned second PaymentIntent)
 *   AAE-LYTX3WIQW3 DB said refund $0.00       Stripe said $32.94 refunded
 *                  (the refund webhook failed on a missing column)
 *
 * Both were found by hand, weeks and hours late respectively. Both were plainly
 * visible to anyone who thought to ask Stripe. So this asks, every day.
 *
 * Rule 5 says Stripe is financial truth. This is the only thing in the platform
 * that actually verifies that claim rather than assuming it.
 *
 * IT NEVER WRITES. Reconciliation decides nothing and repairs nothing — a cron
 * silently rewriting money because it believed an API is far worse than a
 * disagreement it reports. It tells the owner, with both numbers, and a human
 * decides.
 */

const LOOKBACK_DAYS = 120;
const TOLERANCE_CENTS = 0;   // money either matches or it does not

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const startedAt = Date.now();
  const sb = getSupabase();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const findings = [];
  let checked = 0;

  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const { data: bookings, error } = await sb
      .from('bookings')
      .select('id, ref, status, payment_status, amount_charged, total_price, refund_amount, refunded_at, stripe_payment_intent_id, created_at')
      .not('stripe_payment_intent_id', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) throw error;

    for (const b of bookings || []) {
      let intent;
      try {
        intent = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, {
          expand: ['latest_charge'],
        });
      } catch (err) {
        findings.push({
          ref: b.ref,
          kind: 'intent_unreadable',
          detail: `PaymentIntent ${b.stripe_payment_intent_id} could not be read: ${err?.message || err}`,
        });
        continue;
      }
      checked += 1;

      const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
      const receivedCents = Number(intent.amount_received || 0);
      const refundedCents = Number(charge?.amount_refunded || 0);
      const dbCharged = Number(b.amount_charged || 0);
      const dbRefunded = Number(b.refund_amount || 0);

      // 1. We believe we captured money Stripe never took.
      //    This is AAE-MPBUPWVA exactly: a booking pointed at an abandoned
      //    intent while a different one had actually charged.
      const claimsCaptured = ['captured', 'cancellation_fee_captured', 'partially_refunded', 'refunded'].includes(b.payment_status);
      if (claimsCaptured && receivedCents === 0) {
        findings.push({
          ref: b.ref,
          kind: 'captured_but_stripe_received_nothing',
          detail: `DB payment_status=${b.payment_status} (${money(dbCharged)}) but Stripe received ${money(0)} on ${intent.id} (status ${intent.status})`,
        });
      }

      // 2. The captured amount itself disagrees.
      if (claimsCaptured && receivedCents > 0 && Math.abs(receivedCents - dbCharged) > TOLERANCE_CENTS) {
        findings.push({
          ref: b.ref,
          kind: 'captured_amount_mismatch',
          detail: `DB amount_charged ${money(dbCharged)} vs Stripe received ${money(receivedCents)}`,
        });
      }

      // 3. Stripe refunded money our books do not know about.
      //    This is AAE-LYTX3WIQW3: the refund webhook failed and nothing noticed.
      if (Math.abs(refundedCents - dbRefunded) > TOLERANCE_CENTS) {
        findings.push({
          ref: b.ref,
          kind: 'refund_mismatch',
          detail: `DB refund_amount ${money(dbRefunded)} vs Stripe refunded ${money(refundedCents)}`
            + (refundedCents > dbRefunded ? ' — the customer has money back that the books still count as revenue' : ''),
        });
      }

      // 4. A live authorization on a booking that is over.
      if (intent.status === 'requires_capture'
          && ['cancelled', 'declined', 'refunded', 'completed'].includes(b.status)) {
        findings.push({
          ref: b.ref,
          kind: 'authorization_still_held',
          detail: `Booking is ${b.status} but ${intent.id} still holds ${money(intent.amount)} on the customer's card`,
        });
      }
    }

    if (findings.length) {
      const rows = findings.map(f =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #e4e4e7"><strong>${esc(f.ref)}</strong></td>`
        + `<td style="padding:6px 10px;border-bottom:1px solid #e4e4e7;font-family:monospace;font-size:12px">${esc(f.kind)}</td>`
        + `<td style="padding:6px 10px;border-bottom:1px solid #e4e4e7;font-size:13px">${esc(f.detail)}</td></tr>`).join('');
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Stripe reconciliation — ${findings.length} booking(s) disagree with Stripe`,
        html: `<div style="font-family:sans-serif;max-width:760px;margin:0 auto;padding:2rem">
          <h2 style="color:#dc2626">The books and Stripe do not agree</h2>
          <p>${findings.length} of ${checked} checked booking(s) hold a different number than Stripe does. Stripe is financial truth — where they differ, the database is wrong.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${rows}</tbody></table>
          <p style="font-size:13px;color:#52525b;margin-top:16px">Nothing was changed. Reconciliation only reports — a job that rewrites money because it believed an API is worse than a disagreement you can see.</p>
        </div>`,
        meta: { notificationType: 'stripe_reconciliation', recipientType: 'owner', disableDedupe: true },
      }).catch(err => console.error('[stripe-reconciliation] alert failed:', err?.message || err));
    }

    await logCron('stripe-reconciliation', {
      status: findings.length ? 'partial' : 'ok',
      records: checked,
      errorText: findings.length ? `${findings.length} disagreement(s)` : null,
      duration: Date.now() - startedAt,
    });
    return res.status(200).json({ ok: true, checked, findings });
  } catch (err) {
    console.error('[stripe-reconciliation] failed:', err?.message || err);
    await logCron('stripe-reconciliation', { status: 'error', records: checked, errorText: err?.message || String(err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Reconciliation run failed' });
  }
}

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}
