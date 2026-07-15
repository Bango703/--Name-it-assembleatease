import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, isBookingPaymentReadyForDispatch, computeBookingSplitFromSnapshot } from '../_source-of-truth.js';
import { getEaserReadiness, readinessError } from '../_easer-readiness.js';
import { normalizeAssemblerTier } from '../_assembler-state.js';
import { buildEaserFeeSnapshot } from './_easer-fee-snapshot.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

// Offline rails with no card processor behind them, so the platform truly pays
// no Stripe fee on the job.
const NO_PROCESSOR_FEE_METHODS = new Set(['cash', 'zelle', 'cashapp']);

/**
 * POST /api/booking/assign
 * Owner assigns a confirmed booking to an assembler.
 * Completed owner-manual bookings may also be linked to an assembler record
 * for payout/history purposes without reopening the job.
 * Body: { bookingId, assemblerId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, assemblerId, reassign } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const sb = getSupabase();

  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  const recordOnlyOwnerManualCompleted = booking.source === 'owner_manual' && booking.status === BOOKING_STATUS.COMPLETED;
  if (booking.status !== BOOKING_STATUS.CONFIRMED && !recordOnlyOwnerManualCompleted) return res.status(400).json({ error: 'Only confirmed bookings can be assigned' });
  if (!recordOnlyOwnerManualCompleted && !isBookingPaymentReadyForDispatch(booking)) {
    return res.status(409).json({
      error: 'Payment is not verified for assignment. Reconcile Stripe before assigning an Easer.',
      code: 'DISPATCH_PAYMENT_NOT_VERIFIED',
    });
  }
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return res.status(409).json({ error: 'A payment, cancellation, or payout operation is in progress. Wait for it to finish before changing the Easer.' });
  }
  if (booking.assembler_id && !reassign) return res.status(400).json({ error: 'Booking already assigned. Pass reassign:true to override.' });

  // Verify assembler exists and is eligible
  const { data: assembler, error: aErr } = await sb
    .from('profiles')
    .select('id, full_name, email, phone, status, application_status, tier, has_membership, identity_verified, is_available, contractor_agreement_signed_at, contractor_agreement_version, code_of_conduct_agreed_at, application_fee_paid, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, account_closure_status, stripe_connect_account_id, stripe_connect_onboarding_complete, stripe_connect_charges_enabled, stripe_connect_payouts_enabled')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();

  if (aErr) {
    console.error('Assign Easer profile lookup error:', aErr);
    return res.status(503).json({ error: 'Easer membership status could not be verified. Assignment was not changed.' });
  }
  if (!assembler) return res.status(404).json({ error: 'Easer not found' });
  let assemblerTier = normalizeAssemblerTier(assembler.tier) || 'starter';
  if (!recordOnlyOwnerManualCompleted) {
    const readiness = await getEaserReadiness(assembler);
    if (!readiness.isReady) return res.status(400).json({ error: readinessError(readiness), missingItems: readiness.missingItems });
    assemblerTier = readiness.tier;
  }

  // Generate secure assignment token
  const assignedAt = new Date().toISOString();
  let feeSnapshot;
  try {
    feeSnapshot = buildEaserFeeSnapshot(booking, assembler, { snapshottedAt: assignedAt });
  } catch (snapshotError) {
    console.error('Assign Easer fee snapshot error:', snapshotError);
    return res.status(503).json({ error: 'Easer membership status could not be verified. Assignment was not changed.' });
  }

  // Atomic CAS: assign only if the booking is still confirmed and still has the
  // exact current assignment state read above. This prevents owner assignment
  // from reviving a cancelled job or overwriting a competing acceptance.
  const baseUpdates = {
    assembler_id: assemblerId,
    assembler_name: assembler.full_name,
    assembler_tier: assemblerTier,
    assigned_at: assignedAt,
    ...feeSnapshot.updates,
  };
  if (!recordOnlyOwnerManualCompleted) {
    const token = crypto.randomUUID();
    Object.assign(baseUpdates, {
      assignment_token: token,
      assembler_accepted_at: null,
      dispatch_token: null,
      dispatch_status: 'assigned_pending_acceptance',
      dispatch_paused: true,
      needs_manual_dispatch: false,
    });
  } else {
    // The job is already finished and its price is final, so the snapshot taken
    // above IS the earnings truth. Promote it to the same money columns the
    // normal completion path writes — otherwise the Easer who did the work sees
    // $0 earned and no payout is ever owed.
    const split = computeBookingSplitFromSnapshot({
      amountChargedCents: booking.amount_charged,
      totalPriceCents: booking.total_price,
      taxCents: booking.tax_amount || 0,
      feePct: feeSnapshot.feePct,
      assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
    });
    Object.assign(baseUpdates, {
      assembler_accepted_at: booking.completed_at || assignedAt,
      dispatch_token: null,
      dispatch_status: 'accepted',
      dispatch_paused: true,
      needs_manual_dispatch: false,
      assignment_token: booking.assignment_token || null,
      amount_charged: split.totalCents,
      platform_fee_pct: split.feePct,
      platform_fee: split.platformFeeCents,
      assembler_due: split.assemblerDueCents,
      payout_status: split.assemblerDueCents > 0 ? 'pending' : null,
      // Only claim a $0 processor fee on rails that genuinely have none. A card
      // charged outside the platform carries a fee we cannot see from here, so
      // its stripe_fee stays unknown rather than being asserted as zero.
      ...(NO_PROCESSOR_FEE_METHODS.has(booking.payment_method) ? { stripe_fee: 0 } : {}),
    });
  }

  let updateQuery = sb.from('bookings').update(baseUpdates)
    .eq('id', bookingId)
    .eq('status', recordOnlyOwnerManualCompleted ? BOOKING_STATUS.COMPLETED : BOOKING_STATUS.CONFIRMED)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);

  if (!recordOnlyOwnerManualCompleted) {
    updateQuery = updateQuery.eq('payment_status', booking.payment_status);

    updateQuery = booking.total_price == null
      ? updateQuery.is('total_price', null)
      : updateQuery.eq('total_price', booking.total_price);
    updateQuery = booking.stripe_payment_intent_id == null
      ? updateQuery.is('stripe_payment_intent_id', null)
      : updateQuery.eq('stripe_payment_intent_id', booking.stripe_payment_intent_id);
    updateQuery = booking.stripe_deposit_intent_id == null
      ? updateQuery.is('stripe_deposit_intent_id', null)
      : updateQuery.eq('stripe_deposit_intent_id', booking.stripe_deposit_intent_id);
  }

  if (reassign && booking.assembler_id) {
    updateQuery = updateQuery.eq('assembler_id', booking.assembler_id);
    updateQuery = booking.assigned_at == null
      ? updateQuery.is('assigned_at', null)
      : updateQuery.eq('assigned_at', booking.assigned_at);
  } else {
    updateQuery = updateQuery.is('assembler_id', null);
  }

  const { data: assignedRows, error: updateErr } = await updateQuery.select('id, assembler_id');

  if (updateErr) {
    console.error('Assign booking error:', updateErr);
    const guardConflict = ['23503', '23514', '40001'].includes(updateErr.code)
      || /Easer|assignment|readiness|eligible|closure|available/i.test(updateErr.message || '');
    return res.status(guardConflict ? 409 : 500).json({
      error: guardConflict
        ? (recordOnlyOwnerManualCompleted
          ? 'The completed owner booking changed before linking. Refresh and try again.'
          : 'The booking or Easer readiness changed before assignment. Refresh and try again.')
        : 'Failed to assign booking',
      code: guardConflict ? 'EASER_ASSIGNMENT_READINESS_CHANGED' : 'BOOKING_ASSIGNMENT_FAILED',
    });
  }
  if (!assignedRows?.length) {
    return res.status(409).json({
      error: recordOnlyOwnerManualCompleted
        ? 'The completed owner booking changed before linking. Refresh and try again.'
        : 'Booking changed before assignment. Refresh and try again.',
    });
  }

  if (recordOnlyOwnerManualCompleted) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'assigned',
      actorType: 'owner',
      actorName: 'Owner',
      description: `Completed owner booking linked to ${assembler.full_name} for payout/history tracking`,
      metadata: {
        newAssemblerId: assembler.id,
        newAssemblerName: assembler.full_name,
        tier: assemblerTier,
        easerFeePctSnapshot: feeSnapshot.feePct,
        easerEstimatedDueSnapshot: feeSnapshot.estimatedDueCents,
        recordOnlyOwnerManualCompleted: true,
      },
    });

    return res.status(200).json({
      ok: true,
      bookingId: booking.id,
      assignedTo: assembler.full_name,
      recordOnlyOwnerManualCompleted: true,
      feeSnapshot: {
        feePct: feeSnapshot.feePct,
        estimatedDueCents: feeSnapshot.estimatedDueCents,
      },
    });
  }

  // Cancel open auto-dispatch offers only after the assignment CAS succeeds. If
  // the CAS loses, this owner request must not cancel the winning Easer's offer.
  const { error: offerCleanupError } = await sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', bookingId)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);

  if (offerCleanupError) {
    console.error('Assign offer cleanup error:', offerCleanupError);
    await logActivity(sb, {
      bookingId,
      eventType: 'assignment_offer_cleanup_failed',
      actorType: 'system',
      actorName: 'dispatch',
      description: `Booking assigned to ${assembler.full_name}, but open offer cleanup failed`,
      metadata: { error: offerCleanupError.message || String(offerCleanupError) },
    });
  }

  // Update active_jobs_today counters (best-effort, non-blocking):
  // - Increment the new Easer's count
  // - If this is a reassignment to a *different* Easer, decrement the old one
  const prevEaserId = booking.assembler_id; // captured before the DB update
  if (!prevEaserId || prevEaserId !== assemblerId) {
    adjustActiveJobs(sb, assemblerId, +1).catch(() => {});
  }
  if (reassign && prevEaserId && prevEaserId !== assemblerId) {
    adjustActiveJobs(sb, prevEaserId, -1).catch(() => {});
  }

  // Send assembler notification email with Accept/Decline links
  const firstName = (assembler.full_name || 'Easer').split(' ')[0];
  const acceptUrl = `${SITE}/assembler/my-assignments?accept=${bookingId}&token=${token}`;
  const declineUrl = `${SITE}/assembler/my-assignments?decline=${bookingId}&token=${token}`;
  const estimatedPayCents = feeSnapshot.estimatedDueCents;

  let emailResult = { ok: false, error: 'Missing Easer email' };
  try {
    emailResult = await sendEmail({
      to: assembler.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: ownerEmail(),
      subject: `New Job Assignment — ${esc(booking.service)}`,
      html: buildAssignmentEmail({
        firstName,
        service: booking.service,
        date: booking.date,
        time: booking.time,
        estimatedPayCents,
        acceptUrl,
        declineUrl,
        ref: booking.ref,
      }),
      meta: { bookingId: booking.id, notificationType: 'assignment_confirmation', recipientType: 'easer', recipientUserId: assemblerId },
    });
  } catch (e) {
    console.error('Assignment email error:', e);
    emailResult = { ok: false, error: e?.message || String(e) };
  }

  // Push notification — delivery failure never rolls back the assignment.
  const pushResult = await sendPushToUser(assemblerId, {
    title: 'New Job Assigned',
    body:  (booking.service || 'Service') + ' · ' + (booking.date || '') + (booking.time ? ' · ' + booking.time : ''),
    url:   '/assembler/my-assignments',
    jobId: booking.id,
    urgent: true,
  }, { bookingId: booking.id, notificationType: 'assignment_confirmation', recipientType: 'easer' })
    .catch(e => ({ ok: false, error: e?.message || String(e) }));

  const didReassign = Boolean(reassign && prevEaserId && prevEaserId !== assemblerId);
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: didReassign ? 'reassigned' : 'assigned',
    actorType: 'owner',
    actorName: 'Owner',
    description: didReassign
      ? `Booking reassigned from ${booking.assembler_name || 'previous Easer'} to ${assembler.full_name}`
      : `Booking assigned to ${assembler.full_name}`,
    metadata: {
      newAssemblerId: assembler.id,
      newAssemblerName: assembler.full_name,
      previousAssemblerId: prevEaserId || null,
      previousAssemblerName: booking.assembler_name || null,
      tier: assemblerTier,
      easerFeePctSnapshot: feeSnapshot.feePct,
      easerEstimatedDueSnapshot: feeSnapshot.estimatedDueCents,
    },
  });

  const notificationDelivered = Boolean(
    (emailResult?.ok && !emailResult?.suppressed)
    || pushResult?.ok
  );
  if (!notificationDelivered) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'assignment_notification_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `Booking assigned to ${assembler.full_name}, but no notification channel confirmed delivery`,
      metadata: {
        assemblerId,
        assemblerEmail: assembler.email || null,
        emailError: emailResult?.error || emailResult?.reason || null,
        pushError: pushResult?.error || pushResult?.reason || null,
      },
    });
  }
  if (emailResult?.logged === false || pushResult?.logged === false) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'notification_audit_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `Assignment notification was attempted for ${assembler.full_name}, but an attempt log could not be saved`,
      metadata: { emailLogError: emailResult?.logError || null, pushLogError: pushResult?.logError || null },
    });
  }

  return res.status(200).json({
    ok: true,
    assignedTo: assembler.full_name,
    notification: {
      delivered: notificationDelivered,
      email: emailResult,
      push: pushResult,
    },
    warning: [
      notificationDelivered ? null : 'Assigned, but the Easer notification needs owner follow-up.',
      offerCleanupError ? 'Assigned, but stale offer cleanup needs owner follow-up.' : null,
    ].filter(Boolean).join(' ') || null,
  });
}

function buildAssignmentEmail({ firstName, service, date, time, estimatedPayCents, acceptUrl, declineUrl, ref }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:32px 24px">
    <div style="text-align:center;margin-bottom:20px">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </div>
    <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#1a1a1a;text-align:center">New Job Assignment</p>
    <p style="margin:0 0 24px;font-size:14px;color:#52525b;text-align:center">Hi ${esc(firstName)}, you've been assigned a new job.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
        <tr><td style="padding:6px 0;color:#71717a;width:110px">Reference</td><td style="padding:6px 0;font-weight:600">${esc(ref)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Service</td><td style="padding:6px 0;font-weight:600">${esc(service)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Date</td><td style="padding:6px 0">${esc(date || 'TBD')}${time ? ' at ' + esc(time) : ''}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Estimated earnings</td><td style="padding:6px 0;font-weight:700;color:#059669">${estimatedPayCents > 0 ? '$' + (estimatedPayCents / 100).toFixed(2) : 'Pending custom quote'}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Location</td><td style="padding:6px 0">Customer contact and exact address are shown after acceptance.</td></tr>
      </table>
    </td></tr></table>
    <div style="text-align:center;margin-bottom:16px">
      <a href="${acceptUrl}" style="display:inline-block;background:#00BFFF;color:#fff;font-size:14px;font-weight:600;padding:12px 36px;border-radius:6px;text-decoration:none;margin-right:8px">Accept Job</a>
      <a href="${declineUrl}" style="display:inline-block;background:#f4f4f5;color:#71717a;font-size:14px;font-weight:600;padding:12px 36px;border-radius:6px;text-decoration:none;border:1px solid #e4e4e7">Decline</a>
    </div>
    <p style="margin:0;font-size:12px;color:#a1a1aa;text-align:center">Please respond within 24 hours. If you don't respond, the job may be reassigned.</p>
  </td></tr></table>
  <p style="text-align:center;font-size:11px;color:#a1a1aa;margin-top:16px">AssembleAtEase &bull; Austin, TX</p>
</div></body></html>`;
}
