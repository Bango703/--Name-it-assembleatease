import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc, buildReviewCta } from '../_email.js';
import { logActivity } from '../booking/_activity.js';

const ALLOWED_SOURCE_STATUSES = new Set(['confirmed', 'en_route', 'arrived', 'in_progress', 'completed']);

function cleanNote(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 1000);
}

function returnVisitSummary(booking) {
  return `${booking.return_visit_date || 'date not set'}${booking.return_visit_time ? ` at ${booking.return_visit_time}` : ''}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const bookingId = String(payload.bookingId || '').trim();
  const action = String(payload.action || '').trim().toLowerCase();
  const note = cleanNote(payload.note);
  const notifyCustomer = payload.notifyCustomer !== false;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!['complete', 'reopen'].includes(action)) {
    return res.status(400).json({ error: 'action must be complete or reopen' });
  }
  if (note.length < 5) {
    return res.status(400).json({ error: 'Document what happened before changing the return-visit status.' });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingError } = await sb
    .from('bookings')
    .select('id, ref, source, status, payment_status, service, customer_name, customer_email, total_price, assembler_id, return_visit_required, return_visit_date, return_visit_time, return_visit_completed_scope, return_visit_remaining_scope, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.source !== 'owner_manual' || booking.payment_status !== 'offline_recorded') {
    return res.status(409).json({
      error: 'Return-visit recovery is limited to owner-created payment-record bookings.',
      code: 'OWNER_MANUAL_BOOKING_REQUIRED',
    });
  }
  if (!ALLOWED_SOURCE_STATUSES.has(booking.status) || booking.return_visit_required !== true) {
    return res.status(409).json({
      error: 'This booking does not have an open return visit that can be resolved.',
      code: 'RETURN_VISIT_NOT_OPEN',
    });
  }
  if (booking.financial_operation_key
      || booking.financial_operation_type
      || booking.financial_operation_started_at
      || booking.financial_reconciliation_required_at) {
    return res.status(409).json({
      error: 'Resolve the active financial operation before changing the return visit.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }
  if (action === 'reopen' && booking.status !== 'completed') {
    return res.status(409).json({ error: 'Only a mistakenly completed return visit needs to be reopened.' });
  }
  if (action === 'reopen' && booking.assembler_id) {
    return res.status(409).json({
      error: 'This completed booking is already linked to an Easer. Review the assignment before reopening it.',
      code: 'ASSIGNMENT_REVIEW_REQUIRED',
    });
  }
  if (action === 'complete' && booking.status !== 'completed' && booking.assembler_id) {
    return res.status(409).json({
      error: 'The assigned Easer must complete this return visit through the Easer workflow.',
      code: 'EASER_COMPLETION_REQUIRED',
    });
  }

  const now = new Date().toISOString();
  let updates;
  if (action === 'complete') {
    updates = {
      status: 'completed',
      completed_at: now,
      return_visit_required: false,
      return_visit_completed_at: now,
    };
  } else {
    const { data: events, error: eventsError } = await sb
      .from('owner_manual_payment_events')
      .select('amount_cents, refunded_cents, processing_fee_cents, payment_method, stripe_created_at, created_at')
      .eq('booking_id', booking.id);
    if (eventsError) {
      return res.status(503).json({
        error: 'Payment ledger truth is unavailable, so this booking was not reopened.',
        code: 'OWNER_MANUAL_LEDGER_UNAVAILABLE',
      });
    }
    const gross = (events || []).reduce((sum, event) => sum + Number(event.amount_cents || 0), 0);
    const refunded = (events || []).reduce((sum, event) => sum + Number(event.refunded_cents || 0), 0);
    const fees = (events || []).reduce((sum, event) => sum + Number(event.processing_fee_cents || 0), 0);
    const net = Math.max(0, gross - refunded);
    const methods = [...new Set((events || []).map(event => event.payment_method).filter(Boolean))];
    const latestPayment = (events || []).map(event => event.stripe_created_at || event.created_at).filter(Boolean).sort().pop() || null;
    const fullyCollected = net === Number(booking.total_price || 0) && Number(booking.total_price || 0) > 0;
    updates = {
      status: 'confirmed',
      completed_at: null,
      amount_charged: gross > 0 ? gross : null,
      refund_amount: refunded,
      stripe_fee: fees,
      payment_method: methods.length === 1 ? methods[0] : (methods.length > 1 ? 'mixed' : null),
      payment_collected: fullyCollected,
      payment_collected_at: fullyCollected ? latestPayment : null,
      payment_collected_by: fullyCollected ? 'owner' : null,
      platform_fee_pct: 0,
      platform_fee: 0,
      assembler_due: 0,
      payout_status: null,
      payout_mode_snapshot: null,
    };
  }

  let updateQuery = sb.from('bookings').update(updates)
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('source', 'owner_manual')
    .eq('payment_status', 'offline_recorded')
    .eq('return_visit_required', true)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null)
    .select('id, status, return_visit_required, return_visit_completed_at');

  const { data: updatedRows, error: updateError } = await updateQuery;
  if (updateError) {
    console.error('Resolve owner return visit update failed:', updateError);
    return res.status(409).json({
      error: updateError.message || 'The return visit could not be updated safely.',
      code: 'RETURN_VISIT_UPDATE_CONFLICT',
    });
  }
  if (!updatedRows?.length) {
    return res.status(409).json({
      error: 'The booking changed before the return visit could be updated. Refresh and retry.',
      code: 'BOOKING_CHANGED',
    });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: action === 'complete' ? 'return_visit_completed' : 'return_visit_reopened',
    actorType: 'owner',
    actorName: 'Owner',
    description: action === 'complete'
      ? `Return visit completed and final job status recorded. ${note}`
      : `Incorrect completion reopened; remaining return work is active again. ${note}`,
    metadata: {
      priorStatus: booking.status,
      returnVisitDate: booking.return_visit_date,
      returnVisitTime: booking.return_visit_time,
      completedScope: booking.return_visit_completed_scope,
      remainingScope: booking.return_visit_remaining_scope,
      ownerNote: note,
    },
  });

  let notificationDelivered = null;
  let notificationError = null;
  if (notifyCustomer && booking.customer_email) {
    const finalCompletion = action === 'complete';
    const emailResult = await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: finalCompletion
        ? `Your return visit is complete — ${booking.ref}`
        : `Your return visit remains scheduled — ${booking.ref}`,
      html: buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: finalCompletion ? 'COMPLETED' : 'RETURN VISIT SCHEDULED',
        statusColor: finalCompletion ? '#065f46' : '#1e40af',
        statusBg: finalCompletion ? '#d1fae5' : '#dbeafe',
        headline: finalCompletion ? 'Your service is now complete.' : 'We corrected your booking status.',
        bodyHtml: finalCompletion
          ? `<p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">The return visit for your <strong>${esc(booking.service)}</strong> service was completed. Thank you for choosing AssembleAtEase.</p>${buildReviewCta()}`
          : `<p style="margin:0 0 12px;font-size:15px;color:#52525b;line-height:1.7">An earlier completion status was corrected. Your return visit remains scheduled for <strong>${esc(returnVisitSummary(booking))}</strong>.</p><p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.7"><strong>Remaining work:</strong> ${esc(booking.return_visit_remaining_scope || 'Remaining service work')}</p>`,
      }),
      replyTo: ownerEmail(),
      meta: {
        bookingId: booking.id,
        notificationType: finalCompletion ? 'completion' : 'booking_status_correction',
        recipientType: 'customer',
        disableDedupe: true,
      },
    }).catch(error => ({ ok: false, error: error?.message || String(error) }));
    notificationDelivered = emailResult?.ok === true;
    notificationError = emailResult?.ok ? null : (emailResult?.error || 'Delivery failed');
    if (!notificationDelivered) {
      await logActivity(sb, {
        bookingId: booking.id,
        eventType: 'notification_failed',
        actorType: 'system',
        actorName: 'Notifications',
        description: `Return-visit ${action} was saved, but the customer email failed.`,
        metadata: { action, error: notificationError },
      });
    }
  }

  return res.status(200).json({
    ok: true,
    action,
    bookingId: booking.id,
    status: action === 'complete' ? 'completed' : 'confirmed',
    returnVisitRequired: action !== 'complete',
    notificationDelivered,
    notificationError,
  });
}
