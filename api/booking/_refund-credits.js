import { sendEmail, ownerEmail, esc } from '../_email.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { reconcileBookingCredits } from '../_assemblecash.js';

export async function reconcileRefundAssembleCash({
  sb,
  booking,
  cumulativeRefundCents,
  eventSource,
  fullyRefunded,
}) {
  const reconciliation = await reconcileBookingCredits(sb, {
    bookingId: booking.id,
    releaseRedemption: !!fullyRefunded,
    reason: fullyRefunded ? 'reverse:fully_refunded_booking' : 'reverse:booking_refund',
  });
  if (reconciliation?.ok) {
    return { ok: true, reconciliation };
  }

  const idempotencyKey = `assemblecash-refund-reconciliation:${booking.id}:total:${cumulativeRefundCents}`;
  const { data: existingAction, error: lookupError } = await sb.from('financial_event_audit')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .limit(1)
    .maybeSingle();
  let audit = existingAction ? { ok: true } : { ok: false, error: lookupError?.message || null };
  if (!lookupError && !existingAction) {
    audit = await writeFinancialAudit(sb, {
      eventType: 'assemblecash_reversal_required',
      eventSource,
      bookingId: booking.id,
      idempotencyKey,
      status: 'open',
      metadata: {
        ref: booking.ref,
        cumulativeRefundAmountCents: cumulativeRefundCents,
        fullyRefunded: !!fullyRefunded,
        serializedReconciliationFailed: true,
      },
      error: reconciliation?.error || 'AssembleCash refund reconciliation failed',
    });
  }

  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Rewards Reconciliation Required - ${esc(booking.ref)}`,
    html: `<p>The customer refund for <strong>${esc(booking.ref)}</strong> is recorded, but its AssembleCash reward or redeemed credit could not be fully reconciled.</p><p>Keep the financial record open until the rewards ledger is corrected.</p>`,
    meta: { bookingId: booking.id, notificationType: 'assemblecash_reversal_required', recipientType: 'owner' },
  }).catch(error => console.error('Refund rewards owner email failed:', error?.message || error));

  return { ok: false, reconciliation, auditRecorded: !!audit?.ok };
}
