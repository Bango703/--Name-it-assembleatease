import Stripe from 'stripe';
import { getSupabase } from './_supabase.js';
import { sendEmail, ownerEmail, esc } from './_email.js';
import { rateLimit } from './_ratelimit.js';
import { dispatchBooking } from './booking/_dispatch-internal.js';
import { logActivity } from './booking/_activity.js';
import { safeTokenHashMatch } from './_payment-security.js';

/**
 * POST /api/booking-confirmed
 * Called by the frontend after Stripe card authorization succeeds.
 * Sends the customer confirmation email now that payment is on file.
 * Body: { bookingId: string }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  } catch (rlErr) {
    console.error('Rate limit error (Redis unavailable):', rlErr);
  }

  const { bookingId, guestMutationToken } = req.body || {};
  if (!bookingId || !guestMutationToken) return res.status(400).json({ error: 'Missing secure booking confirmation credentials' });

  const sb = getSupabase();
  const { data: booking, error } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_phone, customer_email, address, date, time, details, total_price, stripe_payment_intent_id, stripe_customer_id, payment_status, status, dispatch_status, assembler_id, guest_mutation_token_hash, financial_operation_key, financial_operation_type')
    .eq('id', bookingId)
    .single();

  if (error || !booking) {
    console.error('booking-confirmed fetch error:', error);
    return res.status(404).json({ error: 'Booking not found' });
  }

  async function ensureDispatch() {
    if (booking.status !== 'confirmed' || booking.assembler_id) return;
    try {
      await dispatchBooking(bookingId);
    } catch (dispatchErr) {
      console.error('booking-confirmed dispatch error:', dispatchErr?.message || dispatchErr);
    }
  }

  if (!safeTokenHashMatch(guestMutationToken, booking.guest_mutation_token_hash)) {
    return res.status(403).json({ error: 'Invalid secure booking confirmation token.' });
  }
  if (booking.financial_operation_key) {
    return res.status(409).json({
      error: 'A cancellation or payment action is already being reconciled for this booking. Refresh the tracking page before continuing.',
      code: 'BOOKING_FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }
  // Guard: already confirmed — idempotent, but still retry dispatch in case
  // a prior authorized request confirmed the booking and dispatch later failed.
  if (booking.payment_status === 'authorized' && booking.status === 'confirmed') {
    await ensureDispatch();
    return res.status(200).json({ success: true, alreadyConfirmed: true });
  }

  // Verify the PaymentIntent is genuinely authorized with Stripe before marking the booking.
  // This prevents IDOR abuse where anyone with a bookingId could call this endpoint.
  let verifiedPaymentMethodId = null;
  if (!booking.stripe_payment_intent_id || !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Payment verification is unavailable. Your booking has not been confirmed.' });
  }
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
    const metadataMatches = pi.metadata?.bookingId === booking.id
      && pi.metadata?.type === 'customer_booking';
    const amountMatches = pi.currency === 'usd' && pi.amount === Number(booking.total_price || 0);
    const paymentIntentCustomerId = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || null;
    const customerMatches = !booking.stripe_customer_id || paymentIntentCustomerId === booking.stripe_customer_id;
    const expectedLiveMode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_')
      ? true
      : (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? false : null);
    const modeMatches = expectedLiveMode == null || pi.livemode === expectedLiveMode;
    if (!metadataMatches || !amountMatches || !customerMatches || !modeMatches || pi.capture_method !== 'manual') {
      console.error('[booking-confirmed] PaymentIntent/booking mismatch', {
        bookingId, paymentIntentId: pi.id, metadataMatches, amountMatches, customerMatches, modeMatches,
      });
      return res.status(409).json({
        error: 'Payment details do not match this booking. The booking was not confirmed.',
        code: 'PAYMENT_BOOKING_MISMATCH',
      });
    }
    if (pi.status !== 'requires_capture') {
      console.warn(`[booking-confirmed] PI ${pi.id} in unexpected state: ${pi.status} for booking ${bookingId}`);
      return res.status(402).json({ error: 'Payment is not authorized for later capture. Please complete payment before confirming.' });
    }
    verifiedPaymentMethodId = typeof pi.payment_method === 'string' ? pi.payment_method : null;
  } catch (piErr) {
    console.error('[booking-confirmed] Stripe PI verification error:', piErr);
    return res.status(502).json({ error: 'Could not verify payment status. Please try again.' });
  }

  // Confirm booking + mark card authorized. Promotes status so dispatch can run.
  const updatePayload = {
    payment_status: 'authorized',
    payment_authorized_at: new Date().toISOString(),
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    confirmed_by: 'payment',
  };
  if (booking.dispatch_status === 'payment_hold') {
    updatePayload.dispatch_status = null;
    updatePayload.dispatch_paused = false;
    updatePayload.needs_manual_dispatch = false;
  }
  if (verifiedPaymentMethodId) updatePayload.stripe_payment_method_id = verifiedPaymentMethodId;

  const { error: updateErr, data: updatedRows } = await sb
    .from('bookings')
    .update(updatePayload)
    .eq('id', bookingId)
    .eq('stripe_payment_intent_id', booking.stripe_payment_intent_id)
    .in('status', ['pending', 'confirmed'])
    .in('payment_status', ['pending', 'failed', 'authorized'])
    .is('financial_operation_key', null)
    .select('id');

  if (updateErr) {
    console.error('booking-confirmed status update error:', updateErr);
    return res.status(500).json({
      error: 'Your card was authorized, but the booking could not be confirmed. Please retry; you will not be authorized twice.',
      code: 'CONFIRMATION_PERSIST_FAILED',
    });
  }
  if (!updateErr && (!updatedRows || updatedRows.length === 0)) {
    const { data: current } = await sb
      .from('bookings')
      .select('id, status, payment_status, assembler_id')
      .eq('id', bookingId)
      .maybeSingle();
    if (current?.payment_status === 'authorized' && current?.status === 'confirmed') {
      booking.payment_status = current.payment_status || 'authorized';
      booking.status = current.status || 'confirmed';
      booking.assembler_id = current.assembler_id || null;
      await ensureDispatch();
      return res.status(200).json({ success: true, alreadyConfirmed: true });
    }
    return res.status(409).json({
      error: 'Payment was verified, but booking state changed before confirmation. Please retry or review the booking.',
      code: 'CONFIRMATION_STATE_RACE',
    });
  }

  booking.payment_status = 'authorized';
  booking.status = 'confirmed';

  await ensureDispatch();

  const { ref, service, customer_name: name, customer_email: email, address, date, time, details,
          total_price: amount } = booking;

  const sName    = esc(name);
  const sService = esc(service);
  const sAddress = esc(address);
  const sDate    = esc(date);
  const sTime    = esc(time);
  const sDetails = esc(details);

  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const SITE = 'https://www.assembleatease.com';
  const TO   = ownerEmail();
  // The request token was verified against the current database hash above.
  // Re-deriving the original deterministic token here would email an invalid
  // link after a secure token rotation (for example, a reschedule or recovery).
  const guestTrackUrl = `${SITE}/track?ref=${encodeURIComponent(ref)}&email=${encodeURIComponent(email)}&token=${encodeURIComponent(guestMutationToken)}`;

  const paymentLine = amount > 0
    ? `Your payment method has been verified securely for $${(amount / 100).toFixed(2)}. Payment is processed after the job is complete.`
    : `No payment has been collected for this request.`;

  const customerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">Request received, ${sName}!</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Your payment method has been verified securely and the full total is on record. We process payment after the job is complete. We&rsquo;re matching you with a verified local pro now and will email you again once they&rsquo;re assigned.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Booking Reference</td><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px;text-align:right">Status</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#1a1a1a">${ref}</td><td style="text-align:right"><span style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">MATCHING PRO</span></td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Appointment Details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Services</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sService}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sDate}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sTime}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${sAddress}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:10px 0;line-height:1.6">${sDetails || 'None'}</td></tr>
    </table>
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We match you with a pro</strong> — A verified local pro accepts your job. You'll get a confirmation email the moment they're assigned.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Your technician arrives</strong> — On the scheduled date, a reviewed local pro arrives with the tools needed for the job.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Card authorized — charged after completion</strong> — ${paymentLine}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#92400e;line-height:1.6">
      <strong>Need to change plans?</strong> Reply to this email. Cancel at least 24 hours before your appointment at no charge. Inside 24 hours, a late-cancel fee may apply because a pro has already reserved the time.
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="${esc(guestTrackUrl)}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Track or manage your booking</a>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Austin, TX &bull; Reviewed local pros &bull; Clear pricing</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">You received this email because a booking was submitted at assembleatease.com. To cancel or reschedule, reply to this email.</p>
  </td></tr></table>
</div></body></html>`;

  const customerEmailResult = await sendEmail({
    from: 'AssembleAtEase <booking@assembleatease.com>',
    to: email,
    subject: `Booking request received — ${ref}`,
    html: customerHtml,
    replyTo: TO,
    meta: { bookingId, notificationType: 'booking_confirmed', recipientType: 'customer' },
  });

  if (!customerEmailResult.ok) {
    console.error('booking-confirmed customer send error:', customerEmailResult.error);
  }

  // ── Owner notification — sent here (not in /api/booking) so it only fires
  //    after the card has been successfully authorized. If auth fails, owner
  //    gets no email and the booking stays in Supabase as 'pending' for cleanup.
  const paymentStatus = amount > 0
    ? `CARD AUTHORIZED — $${(amount / 100).toFixed(2)} held, charged after completion`
    : 'No payment required';

  const ownerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="https://www.assembleatease.com/images/logo.jpg" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Notification</td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">New Booking — Card Authorized</p>
    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1a1a1a">Ref: ${esc(ref)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Services</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;line-height:1.5">${esc(service)}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:110px">Customer</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(name)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(address)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(date)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(time)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Payment</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><span style="display:inline-block;background:#d1fae5;color:#065f46;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">${paymentStatus}</span></td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:10px 0;line-height:1.6">${esc(details) || 'None'}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af">Action Required</p>
      <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">Contact <strong>${esc(name)}</strong> to confirm appointment details.</p>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;

  const ownerEmailResult = await sendEmail({
    from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
    to: TO,
    subject: `New Booking (Card Authorized) — ${ref} — ${service}`,
    html: ownerHtml,
    replyTo: email,
    meta: { bookingId, notificationType: 'booking_confirmed', recipientType: 'owner' },
  });

  if (!ownerEmailResult.ok) {
    console.error('booking-confirmed owner send error:', ownerEmailResult.error);
  }

  const sb2 = getSupabase();
  logActivity(sb2, { bookingId, eventType: 'booking_created', actorType: 'customer', actorName: booking.ref ? 'Customer' : 'Unknown', description: `Booking created — card authorized. ${booking.service} on ${booking.date}.`, metadata: { amount: booking.total_price } });

  return res.status(200).json({
    success: true,
    warnings: [
      !customerEmailResult.ok ? 'customer_confirmation_email_failed' : null,
      !ownerEmailResult.ok ? 'owner_notification_email_failed' : null,
    ].filter(Boolean),
  });
}
