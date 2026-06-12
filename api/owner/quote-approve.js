import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';

/**
 * POST /api/owner/quote-approve
 * Owner finalizes a custom quote: sets final price and authorizes the saved card.
 * The card is charged (captured) later when the Easer marks the job complete.
 * Body: { bookingId, finalPriceCents }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, finalPriceCents } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId required' });

  const priceCents = parseInt(finalPriceCents) || 0;
  if (priceCents < 100) return res.status(400).json({ error: 'Price must be at least $1.00' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured' });

  const sb = getSupabase();
  const { data: booking, error } = await sb.from('bookings').select('*').eq('id', bookingId).single();
  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });

  if (!booking.stripe_customer_id || !booking.stripe_payment_method_id) {
    return res.status(400).json({
      error: 'No saved payment method on this booking. Customer must re-submit with a card.',
      code: 'NO_PAYMENT_METHOD',
    });
  }
  if (booking.stripe_payment_intent_id) {
    return res.status(400).json({ error: 'This booking already has a payment authorized.' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Authorize the saved card for the final quote amount.
    // capture_method: 'manual' means no charge until Easer marks job complete.
    const pi = await stripe.paymentIntents.create({
      amount: priceCents,
      currency: 'usd',
      customer: booking.stripe_customer_id,
      payment_method: booking.stripe_payment_method_id,
      capture_method: 'manual',
      confirm: true,
      off_session: true,
      statement_descriptor_suffix: 'ASSEMBLEATEASE',
      description: `Quote approved — ${booking.service} — ${booking.customer_name}`,
      metadata: {
        bookingRef: booking.ref,
        bookingId: booking.id,
        type: 'quote_approved',
      },
    });

    if (pi.status !== 'requires_capture') {
      return res.status(502).json({
        error: `Card authorization returned unexpected status: ${pi.status}. Check Stripe dashboard.`,
        code: 'UNEXPECTED_PI_STATUS',
      });
    }

    const TX_TAX_RATE = 0.0825;
    const subtotal = Math.round(priceCents / (1 + TX_TAX_RATE));
    const tax = priceCents - subtotal;

    // Update booking with final price + payment intent
    await sb.from('bookings').update({
      total_price: priceCents,
      tax_amount: tax,
      stripe_payment_intent_id: pi.id,
      payment_status: 'authorized',
      status: BOOKING_STATUS.CONFIRMED,
    }).eq('id', bookingId);

    // Notify customer that the quote is confirmed and checkout is secure.
    sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your quote is confirmed — ${esc(booking.ref)}`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;padding:28px 24px">
    <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#065f46">Your quote has been confirmed</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b">Hi ${esc((booking.customer_name||'').split(' ')[0])}, we've reviewed your project and set the final price. Here are the details:</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin-bottom:20px">
      <table width="100%" style="font-size:14px;color:#166534">
        <tr><td style="padding:4px 0">Service</td><td style="text-align:right;font-weight:600">${esc(booking.service)}</td></tr>
        <tr><td style="padding:4px 0">Date</td><td style="text-align:right;font-weight:600">${esc(booking.date)}${booking.time ? ' at ' + esc(booking.time) : ''}</td></tr>
        <tr><td style="padding:4px 0">Subtotal</td><td style="text-align:right">$${(subtotal/100).toFixed(2)}</td></tr>
        <tr><td style="padding:4px 0">Tax (8.25%)</td><td style="text-align:right">$${(tax/100).toFixed(2)}</td></tr>
        <tr style="border-top:1px solid #bbf7d0"><td style="padding:8px 0 4px;font-weight:700">Total</td><td style="text-align:right;font-weight:700;font-size:1.1rem">$${(priceCents/100).toFixed(2)}</td></tr>
      </table>
    </div>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#1e40af;line-height:1.65">
      <strong>Secure checkout complete.</strong> Your payment method has been verified securely. Payment is processed after the job is complete.
    </div>
    <p style="font-size:13px;color:#6b7280;margin-bottom:4px">Reference: <strong>${esc(booking.ref)}</strong></p>
    <p style="font-size:13px;color:#6b7280">Questions? <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a></p>
  </div>
</div></body></html>`,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'customer' },
    }).catch(e => console.error('quote-approve customer email error:', e));

    // Notify owner
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Quote approved — ${esc(booking.ref)} — $${(priceCents/100).toFixed(2)}`,
      html: `<p>Quote finalized for <strong>${esc(booking.ref)}</strong>.<br>
Customer: ${esc(booking.customer_name)}<br>
Service: ${esc(booking.service)}<br>
Final price: <strong>$${(priceCents/100).toFixed(2)}</strong><br>
Card authorized. Booking status set to confirmed.</p>`,
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'owner' },
    }).catch(() => {});

    dispatchBooking(bookingId).catch(e => console.error('quote-approve dispatch error:', e.message));

    return res.status(200).json({ ok: true, paymentIntentId: pi.id, amount: priceCents });
  } catch (err) {
    console.error('quote-approve Stripe error:', err);
    // Card declined or Stripe error
    return res.status(502).json({
      error: err.message || 'Failed to authorize card. The customer may need to update their payment method.',
      code: 'STRIPE_ERROR',
    });
  }
}
