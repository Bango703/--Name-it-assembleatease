import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * GET /api/cron/reauth-payments
 * Runs daily at 10:00 UTC via Vercel cron.
 *
 * Stripe manual-capture authorizations expire after 7 days. This cron finds
 * confirmed bookings whose appointment is exactly 5 days away (leaving 2 days
 * buffer before the auth window closes) and silently re-authorizes the card:
 *
 *   1. Retrieve the existing PaymentIntent to get the saved payment_method.
 *   2. Cancel the old PaymentIntent.
 *   3. Create a new PaymentIntent (off_session) and confirm it server-side.
 *   4. Update stripe_payment_intent_id in Supabase.
 *   5. Send the customer a reassurance email.
 *
 * This works because booking.js sets setup_future_usage: 'off_session' on the
 * original PI, which saves the payment method to the Stripe Customer and enables
 * off-session re-authorization without customer interaction.
 *
 * If off-session confirmation fails (e.g. 3DS-required EU card), the error is
 * logged and the old PI is NOT canceled so the original auth remains in place.
 */
export default async function handler(req, res) {
  // Only allow Vercel cron or internal calls
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();

  // Target: booking date is exactly 5 days from today (YYYY-MM-DD)
  const now = new Date();
  const target = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
  const targetStr = target.toISOString().slice(0, 10);

  const { data: bookings, error: queryErr } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_email, date, time, address, total_price, stripe_payment_intent_id, stripe_customer_id')
    .eq('status', 'confirmed')
    .eq('payment_status', 'authorized')
    .eq('date', targetStr)
    .limit(50);

  if (queryErr) {
    console.error('reauth-payments query error:', queryErr);
    return res.status(500).json({ error: 'Query failed' });
  }

  if (!bookings || bookings.length === 0) {
    return res.status(200).json({ ok: true, reauthed: 0, message: 'No bookings require re-authorization today' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let reauthed = 0;
  const errors = [];

  for (const booking of bookings) {
    try {
      if (!booking.stripe_payment_intent_id) {
        console.warn('reauth-payments: no PI id for booking', booking.ref);
        errors.push({ ref: booking.ref, reason: 'no_pi_id' });
        continue;
      }

      // 1. Retrieve the existing PI to get the payment method
      let oldPi;
      try {
        oldPi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
      } catch (retrieveErr) {
        console.error(`reauth-payments: failed to retrieve PI for ${booking.ref}:`, retrieveErr.message);
        errors.push({ ref: booking.ref, reason: 'retrieve_failed' });
        continue;
      }

      const paymentMethod = oldPi.payment_method;
      const customer = oldPi.customer || booking.stripe_customer_id;

      if (!paymentMethod || !customer) {
        console.warn(`reauth-payments: missing payment_method or customer for ${booking.ref}`);
        errors.push({ ref: booking.ref, reason: 'missing_payment_method' });
        continue;
      }

      const amount = booking.total_price || oldPi.amount;
      if (!amount || amount <= 0) {
        console.warn(`reauth-payments: zero amount for ${booking.ref} — skipping`);
        continue;
      }

      // 2. Create the new PI first (before canceling the old one)
      //    If this fails, the old auth remains in place.
      let newPi;
      try {
        newPi = await stripe.paymentIntents.create({
          amount,
          currency: 'usd',
          customer,
          payment_method: paymentMethod,
          capture_method: 'manual',
          confirm: true,
          off_session: true,
          metadata: {
            bookingRef: booking.ref,
            bookingId: booking.id,
            type: 'reauth',
          },
          description: `${booking.service} — ${booking.customer_name} (re-auth)`,
        });
      } catch (piErr) {
        // Card declined, 3DS required, or other Stripe error — leave old PI untouched
        console.error(`reauth-payments: new PI creation failed for ${booking.ref}:`, piErr.message);
        errors.push({ ref: booking.ref, reason: piErr.code || 'pi_create_failed' });
        continue;
      }

      // 3. Cancel the old PI (best-effort — don't abort if this fails)
      try {
        if (oldPi.status === 'requires_capture' || oldPi.status === 'requires_confirmation') {
          await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
        }
      } catch (cancelErr) {
        // Non-fatal — old PI may already be expired/canceled by Stripe
        console.warn(`reauth-payments: could not cancel old PI for ${booking.ref}:`, cancelErr.message);
      }

      // 4. Update Supabase with the new PI id
      const { error: updateErr } = await sb
        .from('bookings')
        .update({ stripe_payment_intent_id: newPi.id })
        .eq('id', booking.id);

      if (updateErr) {
        console.error(`reauth-payments: DB update failed for ${booking.ref}:`, updateErr);
        errors.push({ ref: booking.ref, reason: 'db_update_failed' });
        continue;
      }

      // 5. Send customer reassurance email (non-blocking)
      try {
        const html = buildReauthEmail(booking);
        await sendEmail({
          to: booking.customer_email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Your upcoming appointment is confirmed — ${booking.ref}`,
          html,
          replyTo: 'service@assembleatease.com',
        });
      } catch (emailErr) {
        console.error(`reauth-payments: email failed for ${booking.ref}:`, emailErr.message);
        // Non-fatal — re-auth succeeded even if email failed
      }

      reauthed++;
    } catch (err) {
      console.error(`reauth-payments: unexpected error for ${booking.ref}:`, err);
      errors.push({ ref: booking.ref, reason: 'unexpected' });
    }
  }

  return res.status(200).json({
    ok: true,
    reauthed,
    skipped: errors.length,
    errors: errors.length ? errors : undefined,
  });
}

function buildReauthEmail(booking) {
  const customerFirst = (booking.customer_name || 'there').split(' ')[0];
  const dateStr = booking.date || '';
  const timeStr = booking.time || '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7">
    <tr><td style="padding:20px 24px;text-align:center">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7">
    <tr><td style="padding:28px 24px">

      <p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#1a1a1a">Your booking is all set, ${esc(customerFirst)}!</p>

      <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7">We refreshed your payment authorization for your upcoming appointment. No additional charge &mdash; just keeping your booking secure as your appointment date approaches.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Booking ref</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px">${esc(booking.ref)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(dateStr)}</td></tr>
        ${timeStr ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(timeStr)}</td></tr>` : ''}
        ${booking.address ? `<tr><td style="padding:10px 0;color:#71717a">Address</td><td style="padding:10px 0">${esc(booking.address)}</td></tr>` : ''}
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf9;border:1px solid #bbf7e0;border-radius:6px;margin-bottom:24px">
        <tr><td style="padding:14px 18px;font-size:13px;color:#166534;line-height:1.6">
          Your card is <strong>held (not charged)</strong> until your job is complete and you approve the work. You&rsquo;ll be charged only after we&rsquo;ve finished.
        </td></tr>
      </table>

      <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Have questions? Reply to this email or reach us at <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a>.</p>

    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px">
    <tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
      AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
    </td></tr>
  </table>

</div>
</body></html>`;
}
