import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS, computeBookingFinancialSummary } from '../_source-of-truth.js';
import { loadCurrentCompletionEvidence } from './_completion-evidence.js';
import {
  releaseBookingFinancialOperation,
  reserveBookingFinancialOperation,
} from './_financial-operation.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * POST /api/booking/payout
 * Owner-only: record that an assembler was paid out for a completed job.
 * Body: { bookingId?, ref?, amount (cents), notes? }
 * Sends the assembler a payout confirmation email (#17).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const payload = (req.body && typeof req.body === 'object') ? req.body : {};
  const { bookingId, ref, amount, notes, method } = payload;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  const completedPayout = booking.status === BOOKING_STATUS.COMPLETED;
  const cancellationPayout = booking.status === BOOKING_STATUS.CANCELLED
    && Number(booking.cancellation_easer_due_cents || 0) > 0;
  if (!completedPayout && !cancellationPayout) {
    return res.status(400).json({ error: 'Only completed jobs or fee-bearing cancellations can be paid out. Current status: ' + booking.status });
  }
  if (!booking.assembler_id) {
    return res.status(400).json({ error: 'No assembler assigned to this booking' });
  }
  if (['paid', 'transferred'].includes(booking.payout_status)) {
    return res.status(409).json({ error: 'Payout already recorded for this booking.' });
  }
  if (booking.stripe_transfer_id) {
    return res.status(409).json({ error: 'A Stripe transfer already exists for this booking. Reconcile Stripe instead of recording a manual payout.' });
  }
  const disputeStatus = String(booking.stripe_dispute_status || '').toLowerCase();
  if (booking.stripe_dispute_id && !['won', 'warning_closed', 'prevented'].includes(disputeStatus)) {
    return res.status(409).json({
      error: 'Payout is blocked because Stripe reports a customer dispute on these funds. Resolve the dispute and financial review before paying the Easer.',
      code: 'STRIPE_DISPUTE_PAYOUT_HOLD',
    });
  }
  if (cancellationPayout) {
    if (booking.payment_status !== 'cancellation_fee_captured') {
      return res.status(409).json({ error: 'The customer cancellation fee must be captured before Easer cancellation earnings can be recorded.' });
    }
  } else if (booking.payment_status === 'captured') {
    // Standard completed-job payout path.
  } else if (['partially_refunded', 'refunded'].includes(booking.payment_status)) {
    if (booking.payout_review_status !== 'approved_full') {
      return res.status(409).json({
        error: 'This booking has a customer refund. Review and approve the full Easer earnings before recording payment.',
        code: 'PAYOUT_REVIEW_REQUIRED',
      });
    }
  } else {
    return res.status(409).json({ error: 'Customer funds must be captured before an Easer payout can be recorded.' });
  }

  let hasEvidence = false;
  if (completedPayout) {
    const evidenceResult = await loadCurrentCompletionEvidence(sb, booking, { select: 'id, evidence_type, uploaded_by, created_at' });
    if (evidenceResult.error) {
      console.error('Payout completion evidence lookup failed:', evidenceResult.error);
      return res.status(503).json({ error: 'Completion evidence could not be verified. Payout was not recorded.' });
    }
    hasEvidence = !!evidenceResult.evidence;
  }
  if (booking.evidence_requested_at && !hasEvidence) {
    return res.status(409).json({ error: 'Payout blocked — a completion photo from the current assigned Easer, uploaded after work started, is required.' });
  }
  if (completedPayout && !hasEvidence) {
    console.warn(`[payout-no-evidence] ${booking.ref} — proceeding with no completion evidence on file`);
  }

  const derivedDue = cancellationPayout
    ? Number(booking.cancellation_easer_due_cents || 0)
    : Number(booking.assembler_due || 0);
  if (!derivedDue || derivedDue <= 0) return res.status(409).json({ error: 'Canonical Easer earnings are missing. Reconcile completion before payout.' });
  if (amount != null && Number.parseInt(amount, 10) !== derivedDue) {
    return res.status(409).json({
      error: `Payout amount is server-controlled and must equal $${(derivedDue / 100).toFixed(2)}. Record adjustments separately.`,
      code: 'PAYOUT_AMOUNT_MISMATCH',
    });
  }
  const payoutCents = derivedDue;
  const payoutMethod = String(method || 'manual').trim().toLowerCase();
  const payoutReference = String(notes || '').trim();
  const allowedManualMethods = new Set(['manual', 'ach', 'zelle', 'paypal', 'check']);
  if (!payoutReference) return res.status(400).json({ error: 'A bank confirmation ID, payment reference, or check number is required.' });
  if (!allowedManualMethods.has(payoutMethod)) {
    return res.status(400).json({ error: 'Payout method must be manual, ACH, Zelle, PayPal, or check.' });
  }
  if (booking.payout_mode_snapshot !== 'manual') {
    return res.status(409).json({
      error: booking.payout_mode_snapshot === 'stripe_connect'
        ? 'This earning was assigned to Stripe Connect and cannot be recorded as a manual payout.'
        : 'The payout mode is missing. Apply migration 037 and reconcile this booking before paying it.',
      code: 'PAYOUT_MODE_RECONCILIATION_REQUIRED',
    });
  }
  const operationKey = `payout:manual:${booking.id}`;
  try {
    await reserveBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
      operationType: 'payout_manual',
      expectedStatuses: [booking.status],
      expectedAssemblerId: booking.assembler_id,
      expectedBooking: booking,
    });
  } catch (reservationError) {
    return res.status(reservationError.code === 'FINANCIAL_OPERATION_CONFLICT' ? 409 : 503).json({
      error: reservationError.message,
      code: reservationError.code,
    });
  }

  const payoutDisplay = `$${(payoutCents / 100).toFixed(2)}`;
  const platformRevenue = computeBookingFinancialSummary({
    amountChargedCents: booking.amount_charged || 0,
    totalPriceCents: booking.total_price || 0,
    refundAmountCents: booking.refund_amount || 0,
    taxAmountCents: cancellationPayout ? 0 : (booking.tax_amount || 0),
    stripeFeeCents: booking.stripe_fee,
    assemblerDueCents: payoutCents,
    payoutAmountCents: payoutCents,
  }).platformGrossCents;

  const { data: payoutRows, error: payoutErr } = await sb.rpc('record_booking_payout', {
    p_booking_id: booking.id,
    p_payout_amount_cents: payoutCents,
    p_notes: payoutReference,
    p_recorded_by: 'owner',
    p_payout_method: payoutMethod,
  });

  if (payoutErr) {
    console.error('Payout RPC error:', payoutErr);
    const reconciliation = await reconcileFailedPayoutWrite(sb, { booking, operationKey });
    if (reconciliation.committed) {
      return res.status(200).json({
        success: true,
        alreadyRecorded: true,
        bookingRef: booking.ref,
        payoutAmount: reconciliation.ledger.payout_amount,
        warning: 'The first response failed after the payout record committed. The existing ledger entry was returned.',
      });
    }
    if (reconciliation.released) {
      return res.status(503).json({
        error: 'The payout record did not commit. Its temporary lock was released; verify the external payment reference and retry safely.',
        code: 'PAYOUT_WRITE_RETRY_SAFE',
      });
    }
    return res.status(503).json({
      error: 'Payout state is ambiguous. Do not send another payment; review the booking and payout ledger before retrying.',
      code: 'PAYOUT_RECONCILIATION_REQUIRED',
    });
  }

  const payoutRecord = Array.isArray(payoutRows) ? payoutRows[0] : payoutRows;
  if (!payoutRecord) {
    const reconciliation = await reconcileFailedPayoutWrite(sb, { booking, operationKey });
    if (reconciliation.committed) {
      return res.status(200).json({
        success: true,
        alreadyRecorded: true,
        bookingRef: booking.ref,
        payoutAmount: reconciliation.ledger.payout_amount,
      });
    }
    return res.status(503).json({
      error: 'The payout recorder returned no ledger row. Review financial state before retrying.',
      code: 'PAYOUT_RECONCILIATION_REQUIRED',
    });
  }

  // Load assembler profile separately to avoid relational join drift.
  let assembler = null;
  if (booking.assembler_id) {
    const { data: assemblerProfile } = await sb
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', booking.assembler_id)
      .maybeSingle();
    assembler = assemblerProfile || null;
  }

  // #17 — Send assembler payout notification email
  if (assembler?.email) {
    try {
      await sendEmail({
        to: assembler.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Payout Recorded — ${booking.ref} — ${payoutDisplay}`,
        html: buildPayoutEmail({
          firstName: (assembler.full_name || 'there').split(' ')[0],
          ref: booking.ref,
          service: booking.service,
          date: booking.date,
          payoutDisplay,
          notes: payoutReference,
          method: payoutMethod,
          isCancellation: cancellationPayout,
        }),
        replyTo: ownerEmail(),
        meta: {
          bookingId: booking.id,
          notificationType: 'easer_payout_recorded',
          recipientType: 'easer',
          recipientUserId: booking.assembler_id,
          disableDedupe: true,
        },
      });
    } catch (e) {
      console.error('Payout email error:', e);
    }
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'payout_recorded',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Payout recorded: ${payoutDisplay} to ${assembler?.full_name || 'Easer'}${notes ? ' — ' + notes : ''}`,
    metadata: { payoutCents, platformRevenue, amountCharged: booking.amount_charged || 0 },
  });

  return res.status(200).json({
    success: true,
    bookingRef: payoutRecord.booking_ref || booking.ref,
    assemblerId: payoutRecord.assembler_id || booking.assembler_id,
    payoutAmount: payoutRecord.payout_amount || payoutCents,
    platformRevenue: payoutRecord.platform_revenue ?? platformRevenue,
    amountCharged: payoutRecord.amount_charged || booking.amount_charged || 0,
    hasEvidence,
  });
}

async function reconcileFailedPayoutWrite(sb, { booking, operationKey }) {
  const [{ data: ledger, error: ledgerError }, { data: current, error: bookingError }] = await Promise.all([
    sb.from('payout_ledger')
      .select('booking_id, payout_amount, recorded_at, payout_method, payout_notes')
      .eq('booking_id', booking.id)
      .maybeSingle(),
    sb.from('bookings')
      .select('id, payout_status, payout_amount, financial_operation_key, financial_operation_type')
      .eq('id', booking.id)
      .maybeSingle(),
  ]);

  if (!ledgerError && !bookingError && ledger && current?.payout_status === 'paid') {
    return { committed: true, ledger, current, released: false };
  }

  if (!ledgerError && !bookingError && !ledger
      && current?.payout_status === 'pending'
      && current.financial_operation_key === operationKey
      && current.financial_operation_type === 'payout_manual') {
    try {
      const released = await releaseBookingFinancialOperation(sb, {
        bookingId: booking.id,
        operationKey,
      });
      return { committed: false, ledger: null, current, released };
    } catch (releaseError) {
      console.error('Payout reservation release error:', releaseError);
    }
  }

  if (ledgerError) console.error('Payout reconciliation ledger error:', ledgerError);
  if (bookingError) console.error('Payout reconciliation booking error:', bookingError);
  return { committed: false, ledger: ledger || null, current: current || null, released: false };
}

function buildPayoutEmail({ firstName, ref, service, date, payoutDisplay, notes, method, isCancellation = false }) {
  const methodLabel = method && method !== 'manual' ? method : 'manual payout';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Your payout has been recorded, ${esc(firstName)}.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">AssembleAtEase has recorded a ${esc(methodLabel)} for the following ${isCancellation ? 'eligible cancellation earnings' : 'completed job'}. If you do not receive the funds by the expected timing, reply to this email so we can reconcile it.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Payout Amount</p>
      <p style="margin:0;font-size:26px;font-weight:700;color:#065f46">${esc(payoutDisplay)}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="padding:6px 0;color:#71717a;width:110px;border-bottom:1px solid #f0f0f0">Reference</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(ref)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a;border-bottom:1px solid #f0f0f0">Service</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">${esc(service)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">${isCancellation ? 'Booking date' : 'Date'}</td><td style="padding:6px 0">${esc(date || (isCancellation ? 'Cancelled booking' : 'Completed'))}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Method</td><td style="padding:6px 0">${esc(methodLabel)}</td></tr>
        ${notes ? `<tr><td style="padding:6px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:6px 0">${esc(notes)}</td></tr>` : ''}
      </table>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions about your payout? Contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}
