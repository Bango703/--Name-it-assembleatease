import { sendEmail, ownerEmail, esc } from '../_email.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { reconcileBookingCredits } from '../_assemblecash.js';

export const CANCELLATION_REWARDS_RECONCILIATION_REASON = 'AssembleCash cancellation reconciliation did not complete. Do not retry payment, refund, or payout actions until reviewed.';

export async function reconcileCancellationAssembleCash(sb, booking, eventSource, operationKey) {
  const reconciliation = await reconcileBookingCredits(sb, {
    bookingId: booking.id,
    releaseRedemption: true,
    reason: 'reverse:booking_cancelled',
  });
  // The RPC verifies durable ledger truth, including idempotent retries where
  // the matching redemption was already reversed and the changed-row count is 0.
  const reconciled = reconciliation;
  if (reconciled?.ok) {
    const { data: releasedRows, error: releaseError } = await sb.from('bookings').update({
      financial_operation_key: null,
      financial_operation_type: null,
      financial_operation_started_at: null,
      financial_reconciliation_required_at: null,
      financial_reconciliation_reason: null,
    })
      .eq('id', booking.id)
      .eq('financial_operation_key', operationKey)
      .in('financial_operation_type', ['cancel_owner', 'cancel_customer', 'cancel_guest'])
      .select('id');
    if (!releaseError && releasedRows?.length) {
      return { ok: true, reconciliation: reconciled };
    }
    reconciled.ok = false;
    reconciled.error = `Cancellation rewards reconciled, but its financial lock could not be released: ${releaseError?.message || 'reservation changed'}`;
  }

  const { error: holdError } = await sb.from('bookings').update({
    financial_reconciliation_required_at: new Date().toISOString(),
    financial_reconciliation_reason: CANCELLATION_REWARDS_RECONCILIATION_REASON,
  })
    .eq('id', booking.id)
    .eq('financial_operation_key', operationKey)
    .in('financial_operation_type', ['cancel_owner', 'cancel_customer', 'cancel_guest']);
  if (holdError) console.error('Cancellation rewards hold persistence failed:', holdError.message || holdError);

  const idempotencyKey = `assemblecash-cancellation-reconciliation:${booking.id}`;
  const { data: existingAction, error: lookupError } = await sb.from('financial_event_audit')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .limit(1)
    .maybeSingle();
  let audit = existingAction ? { ok: true } : { ok: false, error: lookupError?.message || null };
  if (!lookupError && !existingAction) {
    audit = await writeFinancialAudit(sb, {
      eventType: 'assemblecash_cancellation_reconciliation_required',
      eventSource,
      bookingId: booking.id,
      idempotencyKey,
      status: 'open',
      metadata: {
        ref: booking.ref,
        serializedReconciliationFailed: reconciled?.ok === false,
      },
      error: reconciled?.error || 'AssembleCash cancellation reconciliation failed',
    });
  }

  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Rewards Reconciliation Required - Cancelled booking ${esc(booking.ref)}`,
    html: `<p>Booking <strong>${esc(booking.ref)}</strong> was cancelled, but its AssembleCash redemption or earned reward could not be fully reconciled.</p><p>Keep the financial record open until the rewards ledger is corrected.</p>`,
    meta: { bookingId: booking.id, notificationType: 'assemblecash_cancellation_reconciliation_required', recipientType: 'owner' },
  }).catch(error => console.error('Cancellation rewards owner email failed:', error?.message || error));

  return {
    ok: false,
    reconciliation: reconciled,
    auditRecorded: !!audit?.ok,
  };
}
