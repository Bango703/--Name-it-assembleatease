import { randomUUID } from 'crypto';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';

const SITE = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';

function whereExact(query, column, value) {
  return value == null ? query.is(column, null) : query.eq(column, value);
}

function hasBookingPaymentState(booking) {
  return Boolean(
    booking.stripe_payment_intent_id
    || booking.stripe_deposit_intent_id
    || booking.stripe_balance_payment_intent_id
    || booking.payment_authorized_at
    || Number(booking.amount_charged || 0) > 0
    || ![null, '', 'pending', 'pending_payment', 'quote_pending_approval', 'failed'].includes(booking.payment_status),
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, date, time, address, service, notifyCustomer, totalPrice, quoteNote } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (['completed', 'cancelled', 'declined', 'refunded'].includes(booking.status)) {
    return res.status(400).json({ error: 'Cannot edit a ' + booking.status + ' booking' });
  }
  if (['en_route', 'arrived', 'in_progress'].includes(booking.status)) {
    return res.status(409).json({
      error: 'This booking is already in active service. Contact the customer and Easer before creating a replacement booking.',
      code: 'BOOKING_WORK_ALREADY_STARTED',
    });
  }
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return res.status(409).json({
      error: 'A payment, cancellation, completion, or payout operation is in progress. Wait for it to finish before editing the booking.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  if (typeof totalPrice === 'number') {
    if (booking.stripe_payment_intent_id
        || ['authorized', 'captured', 'partially_refunded', 'refunded', 'cancellation_fee_captured'].includes(booking.payment_status)) {
      return res.status(409).json({
        error: 'Price is locked because Stripe already has financial state for this booking. Cancel/release the authorization and create a new booking if the scope changed.',
        code: 'PRICE_LOCKED_AFTER_PAYMENT',
      });
    }
    return res.status(409).json({
      error: 'Prices cannot be edited directly. Use the quote approval workflow so the customer sees and approves the exact subtotal, tax, total, and cancellation terms.',
      code: 'CUSTOMER_QUOTE_APPROVAL_REQUIRED',
    });
  }

  const serviceChanged = Boolean(service && service !== booking.service);
  const addressChanged = Boolean(address && address !== booking.address);
  const assignmentExists = Boolean(booking.assembler_id || booking.assigned_at || booking.assembler_accepted_at);
  if ((serviceChanged || addressChanged) && (hasBookingPaymentState(booking) || assignmentExists)) {
    return res.status(409).json({
      error: 'Service and address are locked after payment or Easer assignment. Use the customer-approved quote or replacement-booking workflow for scope changes.',
      code: 'BOOKING_SCOPE_LOCKED',
    });
  }

  const updates = {};
  if (date)    updates.date    = date;
  if (time)    updates.time    = time;
  if (address) updates.address = address;
  if (service) updates.service = service;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const scheduleChanged = Boolean(
    (date && date !== booking.date)
    || (time && time !== booking.time),
  );
  const easerReconfirmationRequired = Boolean(scheduleChanged && booking.assembler_id);
  const nextAssignmentToken = easerReconfirmationRequired ? randomUUID() : booking.assignment_token;
  const currentDispatchAttempt = Number(booking.dispatch_attempt || 0);
  if (scheduleChanged && booking.status === 'confirmed'
      && (!Number.isInteger(currentDispatchAttempt) || currentDispatchAttempt < 0)) {
    return res.status(503).json({ error: 'Dispatch state is invalid. Reconcile this booking before changing its schedule.' });
  }
  if (scheduleChanged) {
    updates.reminder_sent = false;
    if (booking.status === 'confirmed') {
      updates.dispatch_attempt = currentDispatchAttempt + 1;
      updates.dispatch_token = null;
      if (!booking.assembler_id) updates.dispatch_status = null;
    }
  }
  if (easerReconfirmationRequired) {
    Object.assign(updates, {
      assembler_accepted_at: null,
      assignment_token: nextAssignmentToken,
      assigned_at: new Date().toISOString(),
      dispatch_status: 'reconfirmation_required',
      pipeline_stage: 'confirmed',
      dispatch_paused: true,
      needs_manual_dispatch: false,
      en_route_at: null,
      checked_in_at: null,
      job_started_at: null,
    });
  }

  let updateQuery = sb.from('bookings').update(updates)
    .eq('id', bookingId)
    .eq('status', booking.status)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  for (const [column, value] of [
    ['date', booking.date],
    ['time', booking.time],
    ['address', booking.address],
    ['service', booking.service],
    ['payment_status', booking.payment_status],
    ['stripe_payment_intent_id', booking.stripe_payment_intent_id],
    ['stripe_deposit_intent_id', booking.stripe_deposit_intent_id],
    ['stripe_balance_payment_intent_id', booking.stripe_balance_payment_intent_id],
    ['assembler_id', booking.assembler_id],
    ['assembler_accepted_at', booking.assembler_accepted_at],
    ['assigned_at', booking.assigned_at],
    ['assignment_token', booking.assignment_token],
    ['dispatch_status', booking.dispatch_status],
    ['dispatch_attempt', booking.dispatch_attempt],
    ['dispatch_paused', booking.dispatch_paused],
    ['needs_manual_dispatch', booking.needs_manual_dispatch],
    ['reminder_sent', booking.reminder_sent],
  ]) {
    updateQuery = whereExact(updateQuery, column, value);
  }
  const { error: updateErr, data: updatedRows } = await updateQuery.select('id');
  if (updateErr || !updatedRows?.length) {
    console.error('Edit booking error:', updateErr);
    return res.status(409).json({ error: 'Booking state changed before this edit could be saved. Refresh and try again.' });
  }

  let dispatchOfferCleanupFailed = false;
  if (scheduleChanged && booking.status === 'confirmed') {
    const { error: offerCleanupError } = await sb.from('dispatch_offers')
      .update({ offer_status: 'cancelled' })
      .eq('booking_id', booking.id)
      .eq('offer_status', 'sent');
    dispatchOfferCleanupFailed = Boolean(offerCleanupError);
    if (offerCleanupError) console.error('Edit booking dispatch offer cleanup error:', offerCleanupError);
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'owner_booking_updated',
    actorType: 'owner',
    actorName: 'owner',
    description: `Owner updated booking ${booking.ref}${scheduleChanged ? ' and reset schedule dispatch state' : ''}`,
    metadata: {
      updates: Object.keys(updates),
      easerReconfirmationRequired,
      dispatchOfferCleanupFailed,
    },
  });

  const notificationFailures = [];

  // Schedule changes always notify the customer; optional notifications remain
  // available for safe pre-payment service/address corrections.
  if ((notifyCustomer || scheduleChanged) && booking.customer_email) {
    try {
      // Quote notification — when a price is being set for the first time
      const isQuote = typeof totalPrice === 'number' && totalPrice > 0 && (!booking.total_price || booking.total_price === 0);

      if (isQuote) {
        const quoteDollars = (totalPrice / 100).toFixed(2);
        const html = buildStatusEmail({
          customerName: booking.customer_name,
          ref: booking.ref,
          status: 'QUOTE READY',
          statusColor: '#92400e',
          statusBg: '#fef3c7',
          headline: `Your custom quote is ready, ${esc(booking.customer_name)}!`,
          bodyHtml: `
            <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Your Quote</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service)}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.date || 'TBD')}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${esc(booking.address || 'TBD')}</td></tr>
              <tr><td style="padding:10px 0;color:#71717a">Quote Total</td><td style="padding:10px 0;font-weight:800;font-size:18px;color:#065f46">$${esc(quoteDollars)}</td></tr>
            </table>
            ${quoteNote ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:16px"><tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">${esc(quoteNote)}</td></tr></table>` : ''}
            <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply to this email or call us at 737-290-6129.</p>`,
        });
        const customerResult = await sendEmail({
          to: booking.customer_email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Your quote is ready — ${booking.ref}`,
          html,
          replyTo: ownerEmail(),
          meta: { bookingId: booking.id, notificationType: 'owner_booking_update_customer', recipientType: 'customer', disableDedupe: true },
        });
        if (!customerResult?.ok) notificationFailures.push({ recipient: 'customer', error: customerResult?.error || 'Delivery failed' });
      } else {
        const changed = [];
        if (date && date !== booking.date) changed.push('Date updated to <strong>' + esc(date) + '</strong>');
        if (time && time !== booking.time) changed.push('Time updated to <strong>' + esc(time) + '</strong>');
        if (address && address !== booking.address) changed.push('Address updated to <strong>' + esc(address) + '</strong>');
        if (service && service !== booking.service) changed.push('Service updated to <strong>' + esc(service) + '</strong>');
        if (typeof totalPrice === 'number' && totalPrice !== booking.total_price) {
          changed.push('Price updated to <strong>$' + (totalPrice / 100).toFixed(2) + '</strong>');
        }

        if (changed.length) {
          const html = buildStatusEmail({
            customerName: booking.customer_name,
            ref: booking.ref,
            status: 'UPDATED',
            statusColor: '#1e40af',
            statusBg: '#dbeafe',
            headline: 'Your booking has been updated.',
            bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.7">We've made the following changes to your booking:</p>
              <ul style="margin:0 0 20px;padding-left:1.25rem;font-size:14px;color:#52525b;line-height:1.9">${changed.map(c => '<li>' + c + '</li>').join('')}</ul>
              <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply to this email or call us at 737-290-6129.</p>`,
          });
          const customerResult = await sendEmail({
            to: booking.customer_email,
            from: 'AssembleAtEase <booking@assembleatease.com>',
            subject: 'Your booking has been updated — ' + booking.ref,
            html,
            replyTo: ownerEmail(),
            meta: { bookingId: booking.id, notificationType: 'owner_booking_update_customer', recipientType: 'customer', disableDedupe: true },
          });
          if (!customerResult?.ok) notificationFailures.push({ recipient: 'customer', error: customerResult?.error || 'Delivery failed' });
        }
      }
    } catch (e) {
      console.error('Edit booking notify error:', e);
      notificationFailures.push({ recipient: 'customer', error: e?.message || String(e) });
    }
  } else if (scheduleChanged && !booking.customer_email) {
    notificationFailures.push({ recipient: 'customer', error: 'Customer email is missing' });
  }

  if (easerReconfirmationRequired) {
    const { data: easer, error: easerLookupError } = await sb.from('profiles')
      .select('email, full_name')
      .eq('id', booking.assembler_id)
      .maybeSingle();
    if (easerLookupError || !easer?.email) {
      notificationFailures.push({ recipient: 'easer', error: easerLookupError?.message || 'Assigned Easer email is missing' });
    } else {
      const acceptUrl = `${SITE}/assembler/my-assignments?accept=${booking.id}&token=${encodeURIComponent(nextAssignmentToken)}`;
      const easerResult = await sendEmail({
        to: easer.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Action required: job schedule changed - ${booking.ref}`,
        replyTo: ownerEmail(),
        html: `<p>Hi ${esc((easer.full_name || '').split(' ')[0] || 'there')},</p>
          <p>Booking <strong>${esc(booking.ref)}</strong> is now scheduled for <strong>${esc(updates.date || booking.date)}</strong> at <strong>${esc(updates.time || booking.time)}</strong>.</p>
          <p>Review the updated schedule and accept it before starting travel.</p>
          <p><a href="${esc(acceptUrl)}">Review and accept the updated job</a></p>`,
        meta: { bookingId: booking.id, notificationType: 'owner_edit_easer_reconfirmation', recipientType: 'easer', recipientUserId: booking.assembler_id, disableDedupe: true },
      }).catch(error => ({ ok: false, error: error?.message || String(error) }));
      if (!easerResult?.ok) notificationFailures.push({ recipient: 'easer', error: easerResult?.error || 'Delivery failed' });
    }
  }

  if (dispatchOfferCleanupFailed) {
    notificationFailures.push({ recipient: 'dispatch', error: 'Old offers are invalid but could not be marked cancelled; owner review is required.' });
  }
  if (notificationFailures.length) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'owner_booking_update_notification_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: 'Booking changes were saved, but one or more follow-up actions need owner review',
      metadata: { notificationFailures },
    });
  }

  console.log(JSON.stringify({ audit: true, action: 'edit_booking', actor: 'owner', bookingId, updates, timestamp: new Date().toISOString() }));
  return res.status(200).json({
    ok: true,
    easerReconfirmationRequired,
    dispatchOfferCleanupFailed,
    notificationFailures,
  });
}
