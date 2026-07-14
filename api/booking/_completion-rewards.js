import { ASSEMBLECASH, earnForBooking, normalizeEmail } from '../_assemblecash.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { logActivity } from './_activity.js';
import { releaseBookingFinancialOperation } from './_financial-operation.js';

function failure(code, message, error = null) {
  return { ok: false, code, message, error: error?.message || (error ? String(error) : null) };
}

/**
 * Persist and verify the customer reward before releasing the exact completion
 * reservation. A false result deliberately leaves the booking locked so a
 * refund cannot race a late or ambiguous reward write.
 */
export async function finalizeCompletionRewards(sb, {
  booking,
  operationKey,
  amountChargedCents,
} = {}) {
  if (!sb || !booking?.id || !operationKey) {
    return failure('COMPLETION_REWARD_INPUT_INVALID', 'Completion reward reconciliation input is incomplete.');
  }
  if (operationKey !== `complete:${booking.id}`
      || booking.status !== 'completed'
      || booking.payment_status !== 'captured') {
    return failure('COMPLETION_REWARD_STATE_INVALID', 'Completion reward reconciliation requires the exact captured completion lock.');
  }

  const amountCharged = Math.max(0, Math.round(Number(amountChargedCents) || 0));
  const canonicalAmountCharged = Math.max(0, Math.round(Number(booking.amount_charged) || 0));
  if (amountCharged <= 0 || amountCharged !== canonicalAmountCharged) {
    return failure('COMPLETION_REWARD_AMOUNT_MISMATCH', 'Completion reward amount does not match the captured booking amount.');
  }
  const customerEmail = normalizeEmail(booking.customer_email);
  const expectedEarned = customerEmail && amountCharged > 0
    ? Math.round(amountCharged * ASSEMBLECASH.EARN_RATE_PCT / 100)
    : 0;

  if (expectedEarned > 0) {
    try {
      await earnForBooking(sb, {
        bookingId: booking.id,
        bookingRef: booking.ref,
        customerEmail,
        amountChargedCents: amountCharged,
      });
    } catch (error) {
      return failure('COMPLETION_REWARD_WRITE_FAILED', 'AssembleCash could not be persisted.', error);
    }

    const { data: ledgerRow, error: ledgerError } = await sb
      .from('assemblecash_ledger')
      .select('booking_id, booking_ref, customer_email, amount_earned_cents, status, expires_at')
      .eq('booking_id', booking.id)
      .gt('amount_earned_cents', 0)
      .maybeSingle();
    if (ledgerError) {
      return failure('COMPLETION_REWARD_VERIFICATION_FAILED', 'AssembleCash ledger truth could not be verified.', ledgerError);
    }
    const expiresAtMs = Date.parse(ledgerRow?.expires_at || '');
    const ledgerMatches = ledgerRow
      && normalizeEmail(ledgerRow.customer_email) === customerEmail
      && String(ledgerRow.booking_ref || '').trim().toUpperCase() === String(booking.ref || '').trim().toUpperCase()
      && Number(ledgerRow.amount_earned_cents) === expectedEarned
      && ledgerRow.status === 'available'
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > Date.now();
    if (!ledgerMatches) {
      return failure(
        'COMPLETION_REWARD_MISMATCH',
        'AssembleCash ledger truth does not match the captured completion amount.',
      );
    }

  }

  const bookingRewardUpdate = {
    financial_reconciliation_required_at: null,
    financial_reconciliation_reason: null,
    assemblecash_earned_cents: expectedEarned,
  };
  const { data: rewardRows, error: rewardUpdateError } = await sb
    .from('bookings')
    .update(bookingRewardUpdate)
    .eq('id', booking.id)
    .eq('status', 'completed')
    .eq('payment_status', 'captured')
    .eq('financial_operation_key', operationKey)
    .in('financial_operation_type', ['completion_owner', 'completion_easer'])
    .select('id');
  if (rewardUpdateError || rewardRows?.length !== 1) {
    return failure(
      'COMPLETION_REWARD_BOOKING_SYNC_FAILED',
      'The booking reward summary could not be synchronized under the completion lock.',
      rewardUpdateError,
    );
  }

  try {
    const released = await releaseBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
    });
    if (!released) {
      // A same-key completion retry may have released the reservation after
      // this caller verified the reward. Treat that as success only when the
      // canonical booking summary proves the reward is already synchronized.
      const { data: current, error: currentError } = await sb
        .from('bookings')
        .select('status, payment_status, assemblecash_earned_cents, financial_operation_key')
        .eq('id', booking.id)
        .maybeSingle();
      if (!currentError
          && current?.status === 'completed'
          && current?.payment_status === 'captured'
          && Number(current?.assemblecash_earned_cents || 0) === expectedEarned
          && current?.financial_operation_key !== operationKey) {
        return { ok: true, earnedCents: expectedEarned, releasedByPeer: true };
      }
      return failure(
        'COMPLETION_REWARD_LOCK_RELEASE_FAILED',
        'The completion lock did not release after reward verification.',
      );
    }
  } catch (error) {
    const { data: current, error: currentError } = await sb
      .from('bookings')
      .select('status, payment_status, assemblecash_earned_cents, financial_operation_key')
      .eq('id', booking.id)
      .maybeSingle();
    if (!currentError
        && current?.status === 'completed'
        && current?.payment_status === 'captured'
        && Number(current?.assemblecash_earned_cents || 0) === expectedEarned
        && current?.financial_operation_key !== operationKey) {
      return { ok: true, earnedCents: expectedEarned, releasedByPeer: true };
    }
    return failure(
      'COMPLETION_REWARD_LOCK_RELEASE_FAILED',
      'The completion lock could not be released after reward verification.',
      error,
    );
  }

  return { ok: true, earnedCents: expectedEarned };
}

export async function markCompletionRewardReconciliation(sb, {
  bookingId,
  operationKey,
  reason,
} = {}) {
  if (!sb || !bookingId || !operationKey) return false;
  const { data, error } = await sb
    .from('bookings')
    .update({
      financial_reconciliation_required_at: new Date().toISOString(),
      financial_reconciliation_reason: String(reason || 'COMPLETION_REWARD_RECONCILIATION_REQUIRED').slice(0, 500),
    })
    .eq('id', bookingId)
    .eq('status', 'completed')
    .eq('payment_status', 'captured')
    .eq('financial_operation_key', operationKey)
    .in('financial_operation_type', ['completion_owner', 'completion_easer'])
    .select('id');
  if (error) {
    console.error('Completion reward reconciliation marker failed:', error?.message || error);
    return false;
  }
  return data?.length === 1;
}

export async function surfaceCompletionRewardHold(sb, booking, operationKey, rewardResult, {
  actorType,
  actorId = null,
  actorName,
  eventSource,
} = {}) {
  const reason = `${rewardResult?.code || 'COMPLETION_REWARD_RECONCILIATION_REQUIRED'}: ${rewardResult?.message || 'Completion reward truth is ambiguous.'}`;
  await markCompletionRewardReconciliation(sb, {
    bookingId: booking.id,
    operationKey,
    reason,
  });
  await writeFinancialAudit(sb, {
    eventType: 'completion_reward_reconciliation_required',
    eventSource,
    bookingId: booking.id,
    paymentIntentId: booking.stripe_payment_intent_id || booking.stripe_deposit_intent_id || null,
    status: 'failed',
    metadata: { ref: booking.ref, operationKey, code: rewardResult?.code || null },
    error: rewardResult?.error || rewardResult?.message || reason,
  });
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'completion_reward_reconciliation_required',
    actorType,
    actorId,
    actorName,
    description: 'Completion payment is captured, but AssembleCash reward truth needs owner reconciliation. Financial actions remain locked.',
    metadata: { operationKey, code: rewardResult?.code || null, reason },
  });
  if (!booking.financial_reconciliation_required_at) {
    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Completion Reward Hold - ${booking.ref}`,
        html: `<p>Booking <strong>${esc(booking.ref)}</strong> is completed and payment is captured, but the AssembleCash reward could not be verified.</p><p>Refund and other financial actions remain locked. Review Live Ops before taking any separate payment action.</p><p>Reason: ${esc(reason)}</p>`,
        meta: { bookingId: booking.id, notificationType: 'completion_reward_reconciliation_required', recipientType: 'owner' },
      });
    } catch (emailError) {
      console.error('Completion reward hold owner alert failed:', emailError?.message || emailError);
    }
  }
}
