import { getSupabase } from '../_supabase.js';
import {
  buildStatusEmail,
  esc,
  ownerEmail,
  sendEmail,
  verifyOwner,
} from '../_email.js';
import { logActivity } from '../booking/_activity.js';

function cleanCents(value) {
  const cents = Number.parseInt(value, 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function discountFailure(error) {
  const message = String(error?.message || '');
  if (/close_owner_manual_balance_as_discount_v1|does not exist/i.test(message)) {
    return {
      status: 503,
      code: 'MIGRATION_052_REQUIRED',
      error: 'Balance-discount protection is unavailable. Apply migration 052 and retry.',
    };
  }
  if (/finalized or locked|payout_ledger/i.test(message)) {
    return {
      status: 409,
      code: 'OWNER_MANUAL_FINANCIALS_LOCKED',
      error: 'This booking has a completed payout, transfer, or financial operation. The balance was not changed.',
    };
  }
  if (/Refund-affected/i.test(message)) {
    return {
      status: 409,
      code: 'REFUND_RECONCILIATION_REQUIRED',
      error: 'This booking has a refund. Reconcile the refund instead of closing the balance as a discount.',
    };
  }
  if (/changed|no longer match|ineligible/i.test(message)) {
    return {
      status: 409,
      code: 'OWNER_MANUAL_BALANCE_CHANGED',
      error: 'The recorded payments or remaining balance changed. Refresh the booking and review the amount again.',
    };
  }
  return {
    status: 409,
    code: 'OWNER_MANUAL_DISCOUNT_CONFLICT',
    error: 'The final balance could not be closed safely. Refresh the booking; no money or invoice amount was changed.',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const bookingId = String(payload.bookingId || '').trim();
  const expectedTotalCents = cleanCents(payload.expectedTotalCents);
  const expectedDiscountCents = cleanCents(payload.expectedDiscountCents);
  if (!bookingId || !expectedTotalCents || expectedTotalCents <= 0) {
    return res.status(400).json({ error: 'A valid booking and expected total are required.' });
  }
  if (!expectedDiscountCents || expectedDiscountCents <= 0) {
    return res.status(400).json({ error: 'A positive remaining balance is required.' });
  }
  if (payload.acknowledged !== true) {
    return res.status(400).json({
      error: 'Confirm that all customer funds were received and the remaining balance is the discount.',
      code: 'DISCOUNT_ACKNOWLEDGEMENT_REQUIRED',
    });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingError } = await sb
    .from('bookings')
    .select('id, ref, source, status, service, total_price, customer_name, customer_email')
    .eq('id', bookingId)
    .single();
  if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });

  const operationKey = `owner-manual-balance-discount:${booking.id}:${expectedTotalCents}:${expectedDiscountCents}`;
  const adjustmentNote = 'Owner-approved final balance discount after all customer payments were received.';
  const { data: rpcRows, error: rpcError } = await sb.rpc(
    'close_owner_manual_balance_as_discount_v1',
    {
      p_booking_id: booking.id,
      p_operation_key: operationKey,
      p_expected_total_cents: expectedTotalCents,
      p_expected_discount_cents: expectedDiscountCents,
      p_adjustment_note: adjustmentNote,
      p_recorded_by: 'owner',
    },
  );
  if (rpcError) {
    console.error('Close owner-manual balance discount RPC failed:', rpcError);
    const failure = discountFailure(rpcError);
    return res.status(failure.status).json({ error: failure.error, code: failure.code });
  }

  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (!result) {
    return res.status(503).json({
      error: 'The balance-discount reconciliation returned no verified result.',
      code: 'OWNER_MANUAL_DISCOUNT_RESULT_MISSING',
    });
  }

  const alreadyApplied = result.result_action === 'already_applied';
  if (!alreadyApplied) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'customer_balance_discounted',
      actorType: 'owner',
      actorName: 'Owner',
      description: `${money(result.discount_cents)} final customer balance discounted. The adjusted ${money(result.adjusted_total_cents)} total is paid in full; no charge, refund, or payout was created.`,
      metadata: {
        originalTotalCents: Number(result.original_total_cents),
        adjustedTotalCents: Number(result.adjusted_total_cents),
        discountCents: Number(result.discount_cents),
        grossCollectedCents: Number(result.gross_collected_cents),
        processingFeeCents: Number(result.processing_fee_total_cents),
        taxCollectedCents: Number(result.tax_collected_cents),
        easerEarningsPreservedCents: Number(result.easer_earnings_cents),
        platformGrossCents: Number(result.platform_gross_cents),
      },
    }).catch(error => console.warn('Balance-discount activity log skipped:', error?.message || error));
  }

  let notificationDelivered = null;
  let notificationError = null;
  if (!alreadyApplied && booking.customer_email) {
    const emailResult = await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Balance paid in full — ${booking.ref}`,
      html: buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: 'PAID IN FULL',
        statusColor: '#065f46',
        statusBg: '#d1fae5',
        headline: 'Your balance is paid in full.',
        bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Your final payment and customer discount have been applied to your <strong>${esc(booking.service || 'AssembleAtEase')}</strong> service.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:18px">
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;color:#71717a">Original total</td><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;font-weight:700">${money(result.original_total_cents)}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;color:#71717a">Customer discount</td><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;font-weight:700">-${money(result.discount_cents)}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;color:#71717a">Payments received</td><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;font-weight:700">${money(result.gross_collected_cents)}</td></tr>
            <tr><td style="padding:8px 0;color:#71717a">Remaining balance</td><td style="padding:8px 0;text-align:right;font-weight:800;color:#065f46">$0.00</td></tr>
          </table>
          <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">No additional payment is due for this booking.</p>`,
      }),
      replyTo: ownerEmail(),
      meta: {
        bookingId: booking.id,
        notificationType: 'balance_paid_discount_receipt',
        recipientType: 'customer',
        disableDedupe: true,
      },
    }).catch(error => ({ ok: false, error: error?.message || String(error) }));
    notificationDelivered = emailResult?.ok === true;
    notificationError = emailResult?.ok ? null : (emailResult?.error || 'Delivery failed');
    if (!notificationDelivered) {
      await logActivity(sb, {
        bookingId: booking.id,
        eventType: 'balance_discount_receipt_failed',
        actorType: 'system',
        actorName: 'Notifications',
        description: 'The balance was closed, but the customer receipt email failed.',
        metadata: { discountCents: Number(result.discount_cents), error: notificationError },
      }).catch(() => {});
    }
  }

  return res.status(200).json({
    ok: true,
    alreadyApplied,
    bookingId: result.booking_id,
    ref: result.booking_ref,
    originalTotalCents: Number(result.original_total_cents),
    adjustedTotalCents: Number(result.adjusted_total_cents),
    discountCents: Number(result.discount_cents),
    amountCollectedCents: Number(result.gross_collected_cents),
    remainingBalanceCents: 0,
    processingFeeCents: Number(result.processing_fee_total_cents),
    taxCollectedCents: Number(result.tax_collected_cents),
    easerEarningsCents: Number(result.easer_earnings_cents),
    platformGrossCents: Number(result.platform_gross_cents),
    paymentCollected: result.payment_collected === true,
    notificationDelivered,
    notificationError,
  });
}

export { discountFailure };
