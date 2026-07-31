import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { logActivity } from '../booking/_activity.js';
import {
  releaseBookingFinancialOperation,
  reserveBookingFinancialOperation,
} from '../booking/_financial-operation.js';
import {
  createOwnerManualStripeRefunds,
  loadOwnerManualStripeRefundTruth,
} from './_manual-stripe-refund.js';

const MAX_REFUND_CENTS = 2_500_000;
const OPERATION_PREFIX = 'refund:owner-manual:';

function cleanCents(value) {
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? cents : null;
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function operationTarget(booking) {
  if (booking?.financial_operation_type !== 'refund_owner') return null;
  const prefix = `${OPERATION_PREFIX}${booking.id}:total:`;
  const key = String(booking.financial_operation_key || '');
  if (!key.startsWith(prefix)) return null;
  const target = Number.parseInt(key.slice(prefix.length), 10);
  return Number.isInteger(target) && target > 0 ? target : null;
}

async function loadPaymentEvents(sb, bookingId) {
  return sb
    .from('owner_manual_payment_events')
    .select('id, booking_id, amount_cents, refunded_cents, currency, payment_method, processing_fee_cents, stripe_payment_intent_id, stripe_charge_id, stripe_created_at, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });
}

async function reserveManualRefund(sb, booking, operationKey) {
  await reserveBookingFinancialOperation(sb, {
    bookingId: booking.id,
    operationKey,
    operationType: 'refund_owner',
    expectedStatuses: [booking.status],
    expectedAssemblerId: booking.assembler_id || null,
    expectedBooking: booking,
  });
}

async function reconcileSucceededRefunds({
  sb,
  booking,
  truth,
  operationKey,
  reason,
}) {
  const { data: existingRows, error: existingError } = await sb
    .from('owner_manual_refund_events')
    .select('stripe_refund_id')
    .eq('booking_id', booking.id);
  if (existingError) {
    const error = new Error('Manual refund ledger is unavailable. Apply migration 045 before retrying.');
    error.code = 'MIGRATION_045_REQUIRED';
    throw error;
  }

  const existingIds = new Set((existingRows || []).map(row => row.stripe_refund_id));
  let latestResult = null;
  for (const row of truth.rows) {
    let expectedEventRefundedCents = Number(row.event.refunded_cents || 0);
    const missingRefunds = row.succeededRefunds
      .filter(refund => !existingIds.has(refund.id))
      .sort((a, b) => Number(a.created || 0) - Number(b.created || 0)
        || String(a.id).localeCompare(String(b.id)));

    for (const refund of missingRefunds) {
      const refundCreatedAt = Number.isFinite(Number(refund.created))
        ? new Date(Number(refund.created) * 1000).toISOString()
        : null;
      const refundReason = String(refund.metadata?.ownerReason || reason || 'Owner-approved refund')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 500);
      const { data: rpcRows, error: rpcError } = await sb.rpc(
        'record_owner_manual_stripe_refund_event',
        {
          p_booking_id: booking.id,
          p_payment_event_id: row.event.id,
          p_operation_key: operationKey,
          p_expected_event_refunded_cents: expectedEventRefundedCents,
          p_refund_amount_cents: Number(refund.amount),
          p_stripe_refund_id: refund.id,
          p_reason: refundReason,
          p_stripe_created_at: refundCreatedAt,
          p_refunded_by: 'owner',
        },
      );
      if (rpcError) {
        const migrationMissing = /record_owner_manual_stripe_refund_event|owner_manual_refund_events|refunded_cents|does not exist/i
          .test(String(rpcError.message || ''));
        const error = new Error(migrationMissing
          ? 'Manual refund storage is unavailable. Apply migration 045 before retrying.'
          : 'Stripe succeeded, but the manual refund ledger could not be reconciled. Do not retry in Stripe.');
        error.code = migrationMissing
          ? 'MIGRATION_045_REQUIRED'
          : 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED';
        throw error;
      }
      latestResult = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
      expectedEventRefundedCents += Number(refund.amount);
      existingIds.add(refund.id);
    }
  }
  return latestResult;
}

async function sendCustomerRefundEmail({ booking, amountCents, cumulativeRefundCents }) {
  if (!booking.customer_email) return { ok: true, skipped: true };
  const amountDisplay = money(amountCents);
  const cumulativeDisplay = money(cumulativeRefundCents);
  return sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Your ${amountDisplay} refund is on the way — ${booking.ref}`,
    html: buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'REFUNDED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Your refund is on the way, ${esc((booking.customer_name || '').split(' ')[0])}.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">AssembleAtEase issued a refund to the Stripe payment used for your <strong>${esc(booking.service)}</strong> booking.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
          <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Refund amount</p>
          <p style="margin:0;font-size:26px;font-weight:700;color:#065f46">${amountDisplay}</p>
          <p style="margin:5px 0 0;font-size:12px;color:#166534">Total refunds recorded for this booking: ${cumulativeDisplay}</p>
        </td></tr></table>
        <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Refunds typically appear within 5–10 business days depending on your bank. This refund does not by itself cancel a remaining appointment. Questions? Reply to this email or contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>`,
    }),
    replyTo: ownerEmail(),
    meta: {
      bookingId: booking.id,
      notificationType: 'owner_manual_refund',
      recipientType: 'customer',
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({
      error: 'Stripe is unavailable. No refund was attempted.',
      code: 'STRIPE_CONFIGURATION_UNAVAILABLE',
    });
  }

  const payload = (req.body && typeof req.body === 'object') ? req.body : {};
  const bookingId = String(payload.bookingId || '').trim();
  const requestedAmountCents = cleanCents(payload.amountCents);
  const reason = String(payload.reason || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required.' });
  if (reason.length < 3) {
    return res.status(400).json({ error: 'Enter a refund reason of at least 3 characters.' });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingError } = await sb
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .single();
  if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.source !== 'owner_manual' || booking.payment_status !== 'offline_recorded') {
    return res.status(409).json({
      error: 'This refund action is only for verified Stripe payments on owner-created bookings.',
      code: 'OWNER_MANUAL_BOOKING_REQUIRED',
    });
  }
  if (!['completed', 'cancelled'].includes(booking.status)) {
    return res.status(409).json({
      error: 'Complete or cancel the booking before issuing a new refund.',
      code: 'BOOKING_NOT_FINAL_FOR_REFUND',
    });
  }

  const existingTarget = operationTarget(booking);
  if (booking.financial_operation_key && !existingTarget) {
    return res.status(409).json({
      error: 'Another booking or payment action is already in progress. Refresh before trying again.',
      code: 'FINANCIAL_OPERATION_CONFLICT',
    });
  }

  const { data: paymentEvents, error: eventsError } = await loadPaymentEvents(sb, booking.id);
  if (eventsError) {
    return res.status(503).json({
      error: 'Manual payment or refund history is unavailable. Apply migration 045 and retry.',
      code: 'MIGRATION_045_REQUIRED',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let beforeTruth;
  try {
    beforeTruth = await loadOwnerManualStripeRefundTruth({
      stripe,
      booking,
      paymentEvents,
    });
  } catch (truthError) {
    console.error('Owner-manual refund truth lookup failed:', truthError);
    return res.status(409).json({
      error: 'Stripe could not verify the recorded payment and refund history. No refund was attempted.',
      code: truthError.code || 'OWNER_MANUAL_STRIPE_REFUND_TRUTH_MISMATCH',
    });
  }

  if (beforeTruth.ledgerRefundedCents > beforeTruth.stripeRefundedCents) {
    return res.status(503).json({
      error: 'The booking refund ledger exceeds succeeded Stripe refund truth. Do not retry or issue a payout until reconciled.',
      code: 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
    });
  }

  let targetRefundCents = existingTarget;
  let operationKey = booking.financial_operation_key || null;
  let operationReservedHere = false;
  let reconciliationOnly = false;

  if (!operationKey && (beforeTruth.stripeRefundedCents > beforeTruth.ledgerRefundedCents
      || beforeTruth.pendingRefundCents > 0)) {
    targetRefundCents = beforeTruth.stripeRefundedCents + beforeTruth.pendingRefundCents;
    operationKey = `${OPERATION_PREFIX}${booking.id}:total:${targetRefundCents}`;
    try {
      await reserveManualRefund(sb, booking, operationKey);
      operationReservedHere = true;
      reconciliationOnly = true;
    } catch (reservationError) {
      return res.status(reservationError.code === 'FINANCIAL_OPERATION_CONFLICT' ? 409 : 503).json({
        error: reservationError.message,
        code: reservationError.code,
      });
    }
  }

  if (!operationKey) {
    if (!requestedAmountCents
        || requestedAmountCents <= 0
        || requestedAmountCents > MAX_REFUND_CENTS) {
      return res.status(400).json({ error: 'Enter a positive refund amount.' });
    }
    if (requestedAmountCents > beforeTruth.remainingRefundableCents) {
      return res.status(400).json({
        error: `The maximum Stripe amount currently refundable is ${money(beforeTruth.remainingRefundableCents)}.`,
        code: 'REFUND_AMOUNT_EXCEEDS_STRIPE_BALANCE',
      });
    }
    targetRefundCents = beforeTruth.stripeRefundedCents + requestedAmountCents;
    operationKey = `${OPERATION_PREFIX}${booking.id}:total:${targetRefundCents}`;
    try {
      await reserveManualRefund(sb, booking, operationKey);
      operationReservedHere = true;
    } catch (reservationError) {
      return res.status(reservationError.code === 'FINANCIAL_OPERATION_CONFLICT' ? 409 : 503).json({
        error: reservationError.message,
        code: reservationError.code,
      });
    }
  }

  const amountStillNeeded = Math.max(0, targetRefundCents - beforeTruth.stripeRefundedCents);
  if (beforeTruth.pendingRefundCents > 0) {
    try {
      await reconcileSucceededRefunds({
        sb,
        booking,
        truth: beforeTruth,
        operationKey,
        reason,
      });
    } catch (reconciliationError) {
      return res.status(503).json({
        error: reconciliationError.message,
        code: reconciliationError.code || 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
      });
    }
    return res.status(202).json({
      success: false,
      pending: true,
      reconciliationRequired: true,
      cumulativeRefundAmount: beforeTruth.stripeRefundedCents,
      pendingRefundAmount: beforeTruth.pendingRefundCents,
      message: 'Stripe is still processing this refund. Do not retry in Stripe or issue an Easer payout.',
    });
  }

  let refundsCreated = [];
  if (amountStillNeeded > 0 && !reconciliationOnly) {
    const attemptAudit = await writeFinancialAudit(sb, {
      eventType: 'refund_attempt',
      eventSource: 'owner_manual_stripe_refund',
      bookingId: booking.id,
      idempotencyKey: operationKey,
      status: 'processing',
      metadata: {
        ref: booking.ref,
        amount: amountStillNeeded,
        targetCumulativeRefundCents: targetRefundCents,
      },
    });
    if (!attemptAudit?.ok) {
      if (operationReservedHere) {
        await releaseBookingFinancialOperation(sb, { bookingId: booking.id, operationKey }).catch(() => {});
      }
      return res.status(503).json({
        error: 'The refund audit trail could not be opened, so no Stripe refund was attempted.',
        code: 'REFUND_AUDIT_UNAVAILABLE',
      });
    }

    try {
      refundsCreated = await createOwnerManualStripeRefunds({
        stripe,
        booking,
        truth: beforeTruth,
        amountCents: amountStillNeeded,
        reason,
      });
    } catch (stripeError) {
      console.error('Owner-manual Stripe refund failed:', stripeError);
      let afterErrorTruth = null;
      try {
        afterErrorTruth = await loadOwnerManualStripeRefundTruth({
          stripe,
          booking,
          paymentEvents,
        });
      } catch {}
      const stripeAdvanced = afterErrorTruth
        && (afterErrorTruth.stripeRefundedCents > beforeTruth.stripeRefundedCents
          || afterErrorTruth.pendingRefundCents > 0);
      if (!stripeAdvanced && operationReservedHere) {
        await releaseBookingFinancialOperation(sb, {
          bookingId: booking.id,
          operationKey,
        }).catch(() => {});
      }
      return res.status(stripeAdvanced ? 503 : 409).json({
        error: stripeAdvanced
          ? 'Stripe may have advanced the refund. The booking remains locked; recheck only from this booking.'
          : 'Stripe did not complete the refund. No booking refund was recorded.',
        code: stripeAdvanced
          ? 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED'
          : 'REFUND_NOT_SUCCEEDED',
      });
    }
  }

  let afterTruth;
  try {
    afterTruth = await loadOwnerManualStripeRefundTruth({
      stripe,
      booking,
      paymentEvents,
    });
  } catch (truthError) {
    return res.status(503).json({
      error: 'Stripe refund outcome could not be fully verified. The booking remains locked; do not retry or pay out.',
      code: 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
    });
  }

  if (afterTruth.pendingRefundCents > 0) {
    return res.status(202).json({
      success: false,
      pending: true,
      reconciliationRequired: true,
      cumulativeRefundAmount: afterTruth.stripeRefundedCents,
      pendingRefundAmount: afterTruth.pendingRefundCents,
      message: 'Stripe is still processing the refund. Do not retry in Stripe or issue an Easer payout.',
    });
  }
  if (afterTruth.stripeRefundedCents !== targetRefundCents) {
    return res.status(503).json({
      error: 'Stripe refund totals do not match the confirmed target. The booking remains locked for reconciliation.',
      code: 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
    });
  }

  const resultAudit = await writeFinancialAudit(sb, {
    eventType: 'refund_attempt',
    eventSource: 'owner_manual_stripe_refund',
    bookingId: booking.id,
    refundId: refundsCreated.at(-1)?.refund?.id || null,
    idempotencyKey: operationKey,
    status: 'processed',
    metadata: {
      ref: booking.ref,
      amount: Math.max(0, targetRefundCents - beforeTruth.stripeRefundedCents),
      targetCumulativeRefundCents: targetRefundCents,
      refundIds: afterTruth.rows.flatMap(row => row.succeededRefunds.map(refund => refund.id)),
    },
  });
  if (!resultAudit?.ok) {
    return res.status(503).json({
      error: 'Stripe succeeded, but the durable refund audit could not be completed. The booking remains locked.',
      code: 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
    });
  }

  let ledgerResult;
  try {
    ledgerResult = await reconcileSucceededRefunds({
      sb,
      booking,
      truth: afterTruth,
      operationKey,
      reason,
    });
  } catch (reconciliationError) {
    return res.status(503).json({
      error: reconciliationError.message,
      code: reconciliationError.code || 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
    });
  }

  const released = await releaseBookingFinancialOperation(sb, {
    bookingId: booking.id,
    operationKey,
  }).catch(() => false);
  if (!released) {
    return res.status(503).json({
      error: 'Stripe and the booking ledger are reconciled, but the refund lock could not be released.',
      code: 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
    });
  }

  const processedAmountCents = Math.max(
    0,
    targetRefundCents - beforeTruth.stripeRefundedCents,
  );
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'refunded',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Manual Stripe refund processed: ${money(processedAmountCents)} — ${reason}`,
    metadata: {
      refundAmountCents: processedAmountCents,
      cumulativeRefundCents: targetRefundCents,
      netCollectedCents: Number(ledgerResult?.net_collected_cents ?? 0),
      reason,
    },
  }).catch(error => console.warn('Owner-manual refund activity log skipped:', error?.message || error));

  const notification = processedAmountCents > 0
    ? await sendCustomerRefundEmail({
      booking,
      amountCents: processedAmountCents,
      cumulativeRefundCents: targetRefundCents,
    })
    : { ok: true, skipped: true };

  return res.status(200).json({
    success: true,
    reconciled: processedAmountCents === 0,
    amount: processedAmountCents,
    cumulativeRefundAmount: targetRefundCents,
    grossCollectedCents: Number(ledgerResult?.gross_collected_cents ?? beforeTruth.capturedCents),
    netCollectedCents: Number(ledgerResult?.net_collected_cents
      ?? (beforeTruth.capturedCents - targetRefundCents)),
    // A refund does not create a fresh customer invoice. Original captured
    // payments, not net retained revenue, determine invoice collection.
    remainingBalanceCents: Math.max(0, Number(booking.total_price || 0) - beforeTruth.capturedCents),
    paymentCollected: beforeTruth.capturedCents >= Number(booking.total_price || 0),
    easerPayoutAlreadySettled: ['paid', 'transferred']
      .includes(String(booking.payout_status || '')),
    notificationDelivered: notification?.ok === true,
    notificationError: notification?.ok ? null : notification?.error || 'Customer refund email failed',
  });
}
