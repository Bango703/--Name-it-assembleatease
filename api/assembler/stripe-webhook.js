import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

// Vercel: disable body parser so we can verify webhook signature
export const config = { api: { bodyParser: false } };

/**
 * POST /api/assembler/stripe-webhook
 * Handles Stripe Identity and PaymentIntent webhook events.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return res.status(400).json({ error: 'Missing Stripe signature or webhook secret' });
  }

  // Read raw body for signature verification
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid Stripe webhook signature' });
  }

  const sb = getSupabase();

  try {
    switch (event.type) {
      // ── Identity: verification completed successfully ──
      case 'identity.verification_session.verified': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) { console.warn('No userId in verified session metadata'); break; }

        await sb.from('profiles').update({
          identity_verified: true,
          identity_verified_at: new Date().toISOString(),
        }).eq('id', userId);

        // Notify owner
        const { data: profile } = await sb.from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .maybeSingle();

        if (profile) {
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Identity Verified — ${esc(profile.full_name)}`,
              html: buildVerifiedEmail(profile.full_name, profile.email, 'verified'),
            });
          } catch (e) { console.error('Owner verified email error:', e); }
        }
        break;
      }

      // ── Identity: verification requires additional input (failed/expired) ──
      case 'identity.verification_session.requires_input': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) { console.warn('No userId in requires_input session metadata'); break; }

        await sb.from('profiles').update({
          identity_verified: false,
        }).eq('id', userId);

        // Notify both owner and assembler
        const { data: profile } = await sb.from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .maybeSingle();

        if (profile) {
          const lastError = session.last_error?.reason || 'verification could not be completed';
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Identity Verification Failed — ${esc(profile.full_name)}`,
              html: buildVerifiedEmail(profile.full_name, profile.email, 'failed', lastError),
            });
          } catch (e) { console.error('Owner failed email error:', e); }

          try {
            await sendEmail({
              to: profile.email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: 'Action Required — Identity Verification',
              html: buildAssemblerFailEmail(profile.full_name.split(' ')[0], lastError),
              replyTo: ownerEmail(),
            });
          } catch (e) { console.error('Assembler failed email error:', e); }
        }
        break;
      }

      // ── Payment: succeeded (belt-and-suspenders sync) ──
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const userId = pi.metadata?.userId;
        if (userId && pi.metadata?.type === 'assembler_application_fee') {
          await sb.from('profiles').update({
            payment_confirmed: true,
            application_fee_paid: true,
          }).eq('id', userId);
        }
        break;
      }

      // ── Customer booking: card authorized (requires_capture) ──
      case 'payment_intent.amount_capturable_updated': {
        const pi = event.data.object;
        if (pi.metadata?.type !== 'customer_booking') break;

        const { bookingId, isDeposit, depositAmountCents } = pi.metadata;
        if (!bookingId) break;

        const paymentMethodId = pi.payment_method;
        const needsDeposit = isDeposit === 'true' && parseInt(depositAmountCents || '0') > 0;

        // Update booking: authorized
        await sb.from('bookings').update({
          payment_status: 'authorized',
          payment_authorized_at: new Date().toISOString(),
          stripe_payment_method_id: paymentMethodId,
        }).eq('id', bookingId);

        // If deposit job: capture 25% immediately — remaining hold released, card saved for balance later
        if (needsDeposit) {
          const stripe2 = new Stripe(process.env.STRIPE_SECRET_KEY);
          const depositCents = parseInt(depositAmountCents);
          try {
            await stripe2.paymentIntents.capture(pi.id, { amount_to_capture: depositCents });
            await sb.from('bookings').update({
              payment_status: 'deposit_paid',
            }).eq('id', bookingId);
          } catch (capErr) {
            console.error('Deposit capture error:', capErr);
          }
        }

        // Send customer confirmation email
        const { data: bk } = await sb.from('bookings')
          .select('customer_name, customer_email, ref, service, address, date, time, total_price, deposit_amount, is_deposit')
          .eq('id', bookingId).maybeSingle();

        if (bk) {
          const totalDisplay = bk.total_price ? `$${(bk.total_price/100).toFixed(2)}` : 'TBD';
          const depositDisplay = bk.deposit_amount ? `$${(bk.deposit_amount/100).toFixed(2)}` : null;
          try {
            await sendEmail({
              to: bk.customer_email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Booking Confirmed — ${esc(bk.ref)}`,
              html: buildBookingConfirmEmail(bk, totalDisplay, depositDisplay),
              replyTo: ownerEmail(),
            });
          } catch (e) { console.error('Booking confirm email error:', e); }
        }
        break;
      }

      // ── Customer booking: payment captured (job completed) ──
      case 'payment_intent.captured': {
        const pi = event.data.object;
        if (pi.metadata?.type !== 'customer_booking' && pi.metadata?.type !== 'customer_booking_balance') break;

        const { bookingId } = pi.metadata;
        if (!bookingId) break;

        await sb.from('bookings').update({
          payment_status: 'captured',
          amount_charged: pi.amount_received,
        }).eq('id', bookingId);

        // Fetch booking for receipt emails
        const { data: capturedBk } = await sb.from('bookings')
          .select('customer_name, customer_email, ref, service, date')
          .eq('id', bookingId).maybeSingle();

        const capturedAmount = pi.amount_received ? `$${(pi.amount_received / 100).toFixed(2)}` : null;

        if (capturedBk) {
          // #6 — Customer payment receipt
          try {
            await sendEmail({
              to: capturedBk.customer_email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Payment Receipt — ${esc(capturedBk.ref)}`,
              html: buildCustomerReceiptEmail(capturedBk, capturedAmount),
              replyTo: ownerEmail(),
            });
          } catch (e) { console.error('Customer receipt email error:', e); }

          // #22 — Owner capture notification
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Payment Captured — ${esc(capturedBk.ref)} — ${capturedAmount || ''}`,
              html: buildOwnerCaptureEmail(capturedBk, capturedAmount),
            });
          } catch (e) { console.error('Owner capture email error:', e); }
        }
        break;
      }

      // ── Payment: failed ──
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;

        // Assembler application fee failure
        if (pi.metadata?.type === 'assembler_application_fee') {
          const userId = pi.metadata?.userId;
          if (!userId) break;
          const { data: profile } = await sb.from('profiles').select('full_name, email').eq('id', userId).maybeSingle();
          if (profile) {
            const reason = pi.last_payment_error?.message || 'Your payment could not be processed.';
            try {
              await sendEmail({
                to: profile.email,
                from: 'AssembleAtEase <booking@assembleatease.com>',
                subject: 'Payment Failed — AssembleAtEase Application',
                html: buildPaymentFailEmail(profile.full_name.split(' ')[0], reason),
                replyTo: ownerEmail(),
              });
            } catch (e) { console.error('Payment failed email error:', e); }
          }
          break;
        }

        // Customer booking payment failure
        if (pi.metadata?.type === 'customer_booking') {
          const { bookingId } = pi.metadata;
          if (!bookingId) break;

          await sb.from('bookings').update({ payment_status: 'failed' }).eq('id', bookingId);

          const { data: bk } = await sb.from('bookings')
            .select('customer_name, customer_email, ref, service')
            .eq('id', bookingId).maybeSingle();

          const reason = pi.last_payment_error?.message || 'Card could not be authorized.';

          if (bk) {
            // Notify customer
            try {
              await sendEmail({
                to: bk.customer_email,
                from: 'AssembleAtEase <booking@assembleatease.com>',
                subject: `Card Authorization Failed — ${esc(bk.ref)}`,
                html: buildCustomerPaymentFailEmail(bk.customer_name.split(' ')[0], bk.ref, reason),
                replyTo: ownerEmail(),
              });
            } catch (e) { console.error('Customer payment fail email error:', e); }
          }

          // #23 — Owner payment failed notification (branded)
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Payment Failed — ${esc(bk?.ref || bookingId)}`,
              html: buildOwnerPaymentFailEmail(bk?.ref || bookingId, reason, bk?.customer_name),
            });
          } catch (e) { console.error('Owner payment fail email error:', e); }
        }
        break;
      }

      // ── Dispute created — urgent alert ──
      case 'charge.dispute.created': {
        const dispute = event.data.object;
        const disputeAmount = `$${(dispute.amount / 100).toFixed(2)}`;

        // Try to find the related booking via charge → payment intent
        let disputeBk = null;
        try {
          const ch = await stripe.charges.retrieve(dispute.charge);
          if (ch.payment_intent) {
            const { data: foundBk } = await sb.from('bookings')
              .select('customer_name, customer_email, ref, service')
              .eq('stripe_payment_intent_id', ch.payment_intent)
              .maybeSingle();
            disputeBk = foundBk;
          }
        } catch (e) { console.error('Dispute charge lookup error:', e); }

        // #24 — Branded owner URGENT email
        try {
          await sendEmail({
            to: ownerEmail(),
            from: 'AssembleAtEase <booking@assembleatease.com>',
            subject: `URGENT: Chargeback Dispute — ${disputeAmount}`,
            html: buildOwnerDisputeEmail(dispute, disputeAmount, disputeBk),
          });
        } catch (e) { console.error('Dispute owner email error:', e); }

        // #9 — Customer dispute acknowledgment
        if (disputeBk?.customer_email) {
          try {
            await sendEmail({
              to: disputeBk.customer_email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Dispute Received — ${esc(disputeBk.ref)}`,
              html: buildCustomerDisputeEmail(
                (disputeBk.customer_name || '').split(' ')[0],
                disputeBk.ref,
                dispute.reason,
              ),
              replyTo: ownerEmail(),
            });
          } catch (e) { console.error('Customer dispute email error:', e); }
        }
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    // Still return 200 to prevent Stripe retries for logic errors
    return res.status(200).json({ received: true, warning: 'Handler error logged' });
  }

  return res.status(200).json({ received: true });
}

function buildCustomerReceiptEmail(booking, amountDisplay) {
  const firstName = esc((booking.customer_name || '').split(' ')[0]);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Payment received, ${firstName}!</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your payment for <strong>${esc(booking.service)}</strong> has been processed. Thank you for choosing AssembleAtEase!</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Amount Charged</p>
      <p style="margin:0;font-size:26px;font-weight:700;color:#065f46">${amountDisplay || 'See Stripe receipt'}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="padding:5px 0;color:#71717a;width:120px">Reference</td><td style="padding:5px 0;font-weight:600">${esc(booking.ref)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Service</td><td style="padding:5px 0">${esc(booking.service)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Date</td><td style="padding:5px 0">${esc(booking.date || 'Completed')}</td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">A receipt was also sent to your card on file via Stripe. Questions? Contact <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}

function buildOwnerCaptureEmail(booking, amountDisplay) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr>
    <td style="padding:20px 24px"><table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table></td>
    <td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Notification</td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Payment Captured</p>
    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1a1a1a">${amountDisplay || ''} — ${esc(booking.ref)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#065f46;font-weight:600">
      &#10003; Payment successfully captured and on its way to your Stripe balance.
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:120px">Ref</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.ref)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Customer</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(booking.customer_name)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Service</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(booking.service)}</td></tr>
      <tr><td style="padding:8px 0;color:#71717a">Amount</td><td style="padding:8px 0;font-weight:700;color:#065f46">${amountDisplay || 'Check Stripe'}</td></tr>
    </table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:14px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;
}

function buildCustomerDisputeEmail(firstName, ref, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a1a">We received your dispute, ${esc(firstName)}.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">We've been notified that a dispute was filed for booking <strong>${esc(ref)}</strong>. Our team will review this and respond through your bank.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#92400e;line-height:1.6">
      <strong>Dispute reason:</strong> ${esc(reason || 'Not specified')}<br/>
      <span style="margin-top:4px;display:block">Your bank typically resolves disputes within 7–10 business days.</span>
    </td></tr></table>
    <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">If you'd like to resolve this directly, contact us at <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}

function buildOwnerDisputeEmail(dispute, amountDisplay, booking) {
  const bookingRows = booking
    ? `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:120px">Booking Ref</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.ref)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Customer</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(booking.customer_name)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Service</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(booking.service)}</td></tr>`
    : `<tr><td style="padding:8px 0;color:#71717a;width:120px">Charge ID</td><td style="padding:8px 0">${esc(dispute.charge)}</td></tr>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #dc2626"><tr>
    <td style="padding:20px 24px"><table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table></td>
    <td style="padding:20px 24px;text-align:right;font-size:12px;color:#dc2626;font-weight:700">URGENT ACTION REQUIRED</td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#dc2626">&#9888; Chargeback Dispute Opened</p>
      <p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6">A customer has filed a chargeback for <strong>${amountDisplay}</strong>. You have 7–21 days to respond in Stripe.</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
      ${bookingRows}
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:120px">Amount</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:700;color:#dc2626">${amountDisplay}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Reason</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(dispute.reason || 'Not specified')}</td></tr>
      <tr><td style="padding:8px 0;color:#71717a">Status</td><td style="padding:8px 0">${esc(dispute.status || 'needs_response')}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="https://dashboard.stripe.com/disputes" style="display:inline-block;background:#dc2626;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Respond in Stripe Dashboard</a>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:14px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;
}

function buildOwnerPaymentFailEmail(ref, reason, customerName) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr>
    <td style="padding:20px 24px"><table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table></td>
    <td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Alert</td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Payment Failed</p>
    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1a1a1a">Card authorization failed — ${esc(ref)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#dc2626">Authorization failed</p>
      <p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6">Reason: ${esc(reason)}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:120px">Booking Ref</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(ref)}</td></tr>
      ${customerName ? `<tr><td style="padding:8px 0;color:#71717a">Customer</td><td style="padding:8px 0">${esc(customerName)}</td></tr>` : ''}
    </table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:14px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;
}

function buildVerifiedEmail(fullName, email, status, reason = '') {
  const isVerified = status === 'verified';
  const bgColor = isVerified ? '#f0fdf4' : '#fef2f2';
  const borderColor = isVerified ? '#bbf7d0' : '#fecaca';
  const textColor = isVerified ? '#166534' : '#991b1b';
  const headline = isVerified
    ? `${esc(fullName)} — Identity Verified ✓`
    : `${esc(fullName)} — Identity Verification Failed`;
  const detail = isVerified
    ? 'The assembler has successfully completed identity verification and is ready for approval.'
    : `Verification could not be completed. Reason: ${esc(reason)}`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="32" height="32" style="border-radius:50%"/></td>
      <td style="padding-left:10px;font-size:15px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
    <p style="margin:16px 0 4px;font-size:17px;font-weight:700;color:#1a1a1a">${headline}</p>
    <p style="margin:0 0 16px;font-size:13px;color:#52525b">${esc(email)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${bgColor};border:1px solid ${borderColor};border-radius:6px"><tr>
      <td style="padding:12px 16px;font-size:13px;color:${textColor}">${detail}</td>
    </tr></table>
  </td></tr></table>
</div></body></html>`;
}

function buildAssemblerFailEmail(firstName, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Action required, ${esc(firstName)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Your identity verification could not be completed. Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Please contact us at <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a> to resolve this.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildPaymentFailEmail(firstName, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Payment issue, ${esc(firstName)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">We were unable to process your $30 application fee. Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0 0 0;font-size:14px;color:#52525b;line-height:1.6">Please contact us at <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a> to retry.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildBookingConfirmEmail(booking, totalDisplay, depositDisplay) {
  const firstName = esc((booking.customer_name || '').split(' ')[0]);
  const paymentNote = depositDisplay
    ? `A 25% deposit of <strong>${depositDisplay}</strong> has been collected. The remaining balance will be charged after job completion.`
    : `Your card is securely authorized for <strong>${totalDisplay}</strong> and will only be charged after the job is complete.`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:32px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">You're booked, ${firstName}!</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Your appointment is confirmed. ${paymentNote}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="color:#71717a;padding:6px 0;border-bottom:1px solid #f0f0f0;width:120px">Ref</td><td style="font-weight:700;padding:6px 0;border-bottom:1px solid #f0f0f0">${esc(booking.ref)}</td></tr>
        <tr><td style="color:#71717a;padding:6px 0;border-bottom:1px solid #f0f0f0">Service</td><td style="font-weight:600;padding:6px 0;border-bottom:1px solid #f0f0f0">${esc(booking.service)}</td></tr>
        <tr><td style="color:#71717a;padding:6px 0;border-bottom:1px solid #f0f0f0">Date</td><td style="font-weight:700;padding:6px 0;border-bottom:1px solid #f0f0f0">${esc(booking.date)}</td></tr>
        <tr><td style="color:#71717a;padding:6px 0;border-bottom:1px solid #f0f0f0">Time</td><td style="font-weight:700;padding:6px 0;border-bottom:1px solid #f0f0f0">${esc(booking.time)}</td></tr>
        <tr><td style="color:#71717a;padding:6px 0">Address</td><td style="padding:6px 0">${esc(booking.address)}</td></tr>
      </table>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#92400e;line-height:1.6">
      <strong>Cancellation policy:</strong> Cancel at least 24 hours before your appointment for a full release. Cancellations within 24 hours may incur a 50% fee. No-shows will be charged the full amount.
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a">Questions? Reply to this email or contact <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a>.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildCustomerPaymentFailEmail(firstName, ref, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #fecaca"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Card authorization failed, ${esc(firstName)}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#52525b;line-height:1.6">We were unable to authorize your card for booking <strong>${esc(ref)}</strong>.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0;font-size:14px;color:#52525b;line-height:1.6">Please contact us at <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a> to rebook with a different card.</p>
  </td></tr></table>
</div></body></html>`;
}
