import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS, computeBookingFinancialSummary } from '../_source-of-truth.js';

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
  const expectedPaymentStatus = cancellationPayout
    ? 'cancellation_fee_captured'
    : ['captured', 'partially_refunded'];
  if (Array.isArray(expectedPaymentStatus)
      ? !expectedPaymentStatus.includes(booking.payment_status)
      : booking.payment_status !== expectedPaymentStatus) {
    return res.status(409).json({ error: 'Customer funds must be captured before an Easer payout can be recorded.' });
  }

  // Evidence check — hard block when owner has explicitly requested it and none exists yet
  const { data: evidenceRows } = await sb
    .from('booking_evidence')
    .select('id')
    .eq('booking_id', booking.id)
    .limit(1);
  const hasEvidence = !!(evidenceRows?.length);
  if (booking.evidence_requested_at && !hasEvidence) {
    return res.status(409).json({ error: 'Payout blocked — evidence upload required. The owner has requested completion photos before this payout can be processed.' });
  }
  if (!hasEvidence) {
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
  if (!payoutReference) return res.status(400).json({ error: 'A bank confirmation ID, payment reference, or check number is required.' });
  if (payoutMethod === 'stripe_connect') {
    return res.status(400).json({ error: 'Stripe Connect transfers cannot be recorded manually. Use verified Stripe transfer and bank-payout state.' });
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
    if (payoutErr.code === '23505' || /already recorded/i.test(payoutErr.message || '')) {
      return res.status(409).json({ error: 'Payout already recorded for this booking.' });
    }
    console.error('Payout RPC error:', payoutErr);
    return res.status(500).json({ error: 'Failed to record payout' });
  }

  const payoutRecord = Array.isArray(payoutRows) ? payoutRows[0] : payoutRows;
  if (!payoutRecord) {
    return res.status(409).json({ error: 'Payout already recorded for this booking.' });
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
        }),
        replyTo: ownerEmail(),
      });
    } catch (e) {
      console.error('Payout email error:', e);
    }
  }

  logActivity(sb, {
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

function buildPayoutEmail({ firstName, ref, service, date, payoutDisplay, notes, method }) {
  const methodLabel = method && method !== 'manual' ? method : 'manual payout';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Your payout has been recorded, ${esc(firstName)}.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">AssembleAtEase has recorded a ${esc(methodLabel)} for the following completed job. If you do not receive the funds by the expected timing, reply to this email so we can reconcile it.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Payout Amount</p>
      <p style="margin:0;font-size:26px;font-weight:700;color:#065f46">${esc(payoutDisplay)}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="padding:6px 0;color:#71717a;width:110px;border-bottom:1px solid #f0f0f0">Reference</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(ref)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a;border-bottom:1px solid #f0f0f0">Service</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">${esc(service)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Date</td><td style="padding:6px 0">${esc(date || 'Completed')}</td></tr>
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
