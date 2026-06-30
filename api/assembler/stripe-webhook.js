import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { claimStripeWebhookEvent, finalizeStripeWebhookEvent, writeFinancialAudit } from '../_financial-audit.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { releasePendingRedemption } from '../_assemblecash.js';
import { bestEffortProfileUpdate, buildIdentityResumeUrl, ensureIdentityResumeToken } from '../_assembler-onboarding.js';

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

  // Two Stripe webhook endpoints share the same handler URL but carry different
  // signing secrets: one for Connect/Payment events (STRIPE_WEBHOOK_SECRET) and
  // one for Identity events (STRIPE_IDENTITY_WEBHOOK_SECRET). Try both so that
  // adding a second endpoint never causes the other to silently reject.
  const primarySecret   = process.env.STRIPE_WEBHOOK_SECRET;
  const identitySecret  = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET;
  const secrets = [primarySecret, identitySecret].filter(Boolean);

  if (!sig || secrets.length === 0) {
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
  let verifyErr;

  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
      break; // verified successfully with this secret
    } catch (err) {
      verifyErr = err;
    }
  }

  if (!event) {
    console.error('Stripe webhook signature verification failed (tried', secrets.length, 'secrets):', verifyErr?.message);
    return res.status(400).json({ error: 'Invalid Stripe webhook signature' });
  }

  const sb = getSupabase();
  const claim = await claimStripeWebhookEvent(sb, event);
  if (claim.duplicate) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  let webhookOutcome = 'processed';
  let webhookError = null;
  let webhookBookingId = null;
  let webhookPaymentIntentId = null;
  let webhookMetadata = { eventType: event.type };

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
        await bestEffortProfileUpdate(sb, userId, {
          id_verification_status: 'verified',
          stripe_identity_session_id: session.id,
        });

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
              meta: { notificationType: 'identity_verified_owner', recipientType: 'owner' },
            });
          } catch (e) { console.error('Owner verified email error:', e); }

          try {
            await sendEmail({
              to: profile.email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: 'Identity Verified — Application Review Pending',
              html: buildApplicantVerifiedEmail(profile.full_name.split(' ')[0]),
              replyTo: ownerEmail(),
              meta: { notificationType: 'identity_verified_applicant', recipientType: 'easer', recipientUserId: userId },
            });
          } catch (e) { console.error('Applicant verified email error:', e); }
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
        await bestEffortProfileUpdate(sb, userId, {
          id_verification_status: 'failed',
          stripe_identity_session_id: session.id,
        });

        // Notify both owner and assembler
        const { data: profile } = await sb.from('profiles')
          .select('full_name, email, identity_resume_token')
          .eq('id', userId)
          .maybeSingle();

        if (profile) {
          const lastError = session.last_error?.reason || 'verification could not be completed';
          const resumeToken = await ensureIdentityResumeToken(sb, { id: userId, identity_resume_token: profile.identity_resume_token });
          const resumeUrl = buildIdentityResumeUrl(resumeToken);
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Identity Verification Failed — ${esc(profile.full_name)}`,
              html: buildVerifiedEmail(profile.full_name, profile.email, 'failed', lastError),
              meta: { notificationType: 'identity_failed_owner', recipientType: 'owner' },
            });
          } catch (e) { console.error('Owner failed email error:', e); }

          try {
            await sendEmail({
              to: profile.email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: 'Action Required — Retry Identity Verification',
              html: buildAssemblerFailEmail(profile.full_name.split(' ')[0], lastError, resumeUrl),
              replyTo: ownerEmail(),
              meta: { notificationType: 'identity_failed_applicant', recipientType: 'easer', recipientUserId: userId },
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

        const { bookingId } = pi.metadata;
        if (!bookingId) break;
        webhookBookingId = bookingId;
        webhookPaymentIntentId = pi.id;

        const { data: existing } = await sb.from('bookings')
          .select('id, ref, payment_status, status, customer_name, customer_email, service, address, date, time, total_price, deposit_amount, is_deposit, assembler_id')
          .eq('id', bookingId)
          .maybeSingle();

        if (!existing) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found', bookingId };
          break;
        }

        if (['captured', 'refunded', 'deposit_paid'].includes(existing.payment_status)) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'stale-authorize-event', bookingId, currentPaymentStatus: existing.payment_status };
          break;
        }

        if (existing.payment_status === 'authorized' || existing.status === 'confirmed') {
          if (existing.status === 'confirmed' && !existing.assembler_id) {
            dispatchBooking(bookingId).catch(err => console.error('webhook dispatch retry error:', err?.message || err));
          }
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'already-authorized', bookingId, currentPaymentStatus: existing.payment_status, currentStatus: existing.status };
          break;
        }

        const paymentMethodId = pi.payment_method;
        // Update booking: authorized only from pre-capture states. Also promote to
        // confirmed so webhook-only authorization cannot strand dispatch.
        const { error: authErr, data: authRows } = await sb.from('bookings').update({
          payment_status: 'authorized',
          payment_authorized_at: new Date().toISOString(),
          stripe_payment_method_id: paymentMethodId,
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          confirmed_by: 'stripe_webhook',
        })
          .eq('id', bookingId)
          .eq('payment_status', 'pending')
          .neq('payment_status', 'captured')
          .neq('payment_status', 'refunded')
          .neq('payment_status', 'deposit_paid')
          .select('id');

        if (authErr) {
          webhookOutcome = 'failed';
          webhookError = authErr.message || 'Failed to sync authorized status';
          break;
        }
        if (!authRows || authRows.length === 0) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'authorization-state-not-pending', bookingId, currentPaymentStatus: existing.payment_status, currentStatus: existing.status };
          break;
        }

        dispatchBooking(bookingId).catch(err => console.error('webhook dispatch error:', err?.message || err));

        // Send customer confirmation email
        const bk = existing;

        if (bk) {
          const totalDisplay = bk.total_price ? `$${(bk.total_price/100).toFixed(2)}` : 'TBD';
          try {
            await sendEmail({
              to: bk.customer_email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Booking Confirmed — ${esc(bk.ref)}`,
              html: buildBookingConfirmEmail(bk, totalDisplay),
              replyTo: ownerEmail(),
              meta: { bookingId, notificationType: 'booking_confirmed', recipientType: 'customer' },
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
        webhookBookingId = bookingId;
        webhookPaymentIntentId = pi.id;

        const { data: current } = await sb.from('bookings')
          .select('id, payment_status, status, amount_charged, customer_name, customer_email, ref, service, date')
          .eq('id', bookingId)
          .maybeSingle();

        if (!current) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found', bookingId };
          break;
        }

        if (current.payment_status === 'refunded') {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'stale-captured-after-refund', bookingId };
          break;
        }

        if (current.payment_status === 'captured' && current.status === 'completed') {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'already-captured-and-completed', bookingId };
          break;
        }

        await sb.from('bookings').update({
          payment_status: 'captured',
          amount_charged: pi.amount_received,
          payment_captured_at: new Date().toISOString(),
        }).eq('id', bookingId).neq('payment_status', 'refunded');

        logActivity(sb, {
          bookingId,
          eventType: 'captured',
          actorType: 'system',
          actorName: 'stripe_webhook',
          description: `Stripe webhook captured payment: $${((pi.amount_received || 0) / 100).toFixed(2)}`,
          metadata: { stripeEventId: event.id, paymentIntentId: pi.id, amountCharged: pi.amount_received || 0 },
        });

        // Fetch booking for receipt emails
        const capturedBk = current;

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
        webhookPaymentIntentId = pi.id;

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
          webhookBookingId = bookingId;

          const { data: currentBooking } = await sb.from('bookings')
            .select('id, payment_status, status, customer_name, customer_email, ref, service')
            .eq('id', bookingId)
            .maybeSingle();

          if (!currentBooking) {
            webhookOutcome = 'ignored';
            webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found', bookingId };
            break;
          }

          if (['captured', 'deposit_paid', 'refunded'].includes(currentBooking.payment_status)) {
            webhookOutcome = 'ignored';
            webhookMetadata = {
              ...webhookMetadata,
              reason: 'stale-payment-failed',
              bookingId,
              currentPaymentStatus: currentBooking.payment_status,
            };
            break;
          }

          await sb.from('bookings').update({ payment_status: 'failed' }).eq('id', bookingId);
          await releasePendingRedemption(sb, {
            bookingId,
            bookingRef: currentBooking.ref,
            customerEmail: currentBooking.customer_email,
            reason: 'reverse:payment_failed',
          });

          logActivity(sb, {
            bookingId,
            eventType: 'payment_failed',
            actorType: 'system',
            actorName: 'stripe_webhook',
            description: `Stripe reported payment failure: ${pi.last_payment_error?.message || 'Card authorization failed'}`,
            metadata: { stripeEventId: event.id, paymentIntentId: pi.id },
          });

          const bk = currentBooking;

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

      // ── Refund sync: keep booking truth aligned to Stripe refund truth ──
      case 'charge.refunded': {
        const charge = event.data.object;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        if (!paymentIntentId) break;

        webhookPaymentIntentId = paymentIntentId;

        const { data: booking } = await sb.from('bookings')
          .select('id, ref, payment_status')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .maybeSingle();

        if (!booking) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found-for-refund', paymentIntentId };
          break;
        }

        webhookBookingId = booking.id;

        let { error: refundSyncErr } = await sb.from('bookings').update({
          payment_status: 'refunded',
          refund_amount: charge.amount_refunded || 0,
          refunded_at: new Date().toISOString(),
        }).eq('id', booking.id).neq('payment_status', 'refunded');

        if (refundSyncErr) {
          // Some environments may not have refund columns yet. Preserve core truth by
          // falling back to payment_status-only sync instead of dropping the webhook update.
          const fallback = await sb.from('bookings').update({
            payment_status: 'refunded',
          }).eq('id', booking.id).neq('payment_status', 'refunded');
          refundSyncErr = fallback.error || null;
        }

        if (refundSyncErr) {
          webhookOutcome = 'failed';
          webhookError = refundSyncErr.message || 'Refund sync failed';
          webhookMetadata = { ...webhookMetadata, reason: 'refund-sync-update-failed', paymentIntentId };
          break;
        }

        logActivity(sb, {
          bookingId: booking.id,
          eventType: 'refunded',
          actorType: 'system',
          actorName: 'stripe_webhook',
          description: `Stripe webhook refund sync: $${((charge.amount_refunded || 0) / 100).toFixed(2)}`,
          metadata: { stripeEventId: event.id, paymentIntentId, amountRefunded: charge.amount_refunded || 0 },
        });

        await writeFinancialAudit(sb, {
          eventType: 'refund_sync',
          eventSource: 'stripe_webhook',
          stripeEventId: event.id,
          bookingId: booking.id,
          paymentIntentId,
          status: 'processed',
          eventCreatedAt: event.created ? new Date(event.created * 1000).toISOString() : null,
          metadata: { amountRefunded: charge.amount_refunded || 0, chargeId: charge.id || null },
        });

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

      // ── Easer Membership: subscription activated ──
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (!userId) break;
        const active = sub.status === 'active' || sub.status === 'trialing';
        await sb.from('profiles').update({
          has_membership: active,
          membership_expires_at: active ? new Date(sub.current_period_end * 1000).toISOString() : null,
          stripe_subscription_id: sub.id,
          membership_tier: active ? 'member' : null,
        }).eq('id', userId);
        if (active) {
          const { data: p } = await sb.from('profiles').select('full_name, email').eq('id', userId).maybeSingle();
          if (p) {
            sendEmail({
              to: p.email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: 'Membership Active — You now get priority jobs!',
              html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
                <h2 style="color:#00BFFF">Your membership is active!</h2>
                <p>Hi ${esc((p.full_name||'').split(' ')[0])}, you now have priority access to jobs on AssembleAtEase. You'll be notified first for jobs in your area before non-members.</p>
                <p style="color:#6b7280;font-size:0.875rem">Questions? Email service@assembleatease.com</p>
              </div>`,
            }).catch(e => console.error('Membership welcome email error:', e));
          }
        }
        break;
      }

      // ── Easer Membership: subscription cancelled/expired ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (!userId) break;
        await sb.from('profiles').update({
          has_membership: false,
          membership_expires_at: null,
          stripe_subscription_id: null,
          membership_tier: null,
        }).eq('id', userId);
        break;
      }

      // ── Easer Membership: invoice paid (renewal) ──
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        if (inv.subscription && inv.metadata?.role !== 'assembler_membership') {
          // Try to find by subscription ID
          const { data: profiles } = await sb.from('profiles')
            .select('id').eq('stripe_subscription_id', inv.subscription).limit(1);
          if (profiles && profiles[0]) {
            const stripe2 = new Stripe(process.env.STRIPE_SECRET_KEY);
            const sub = await stripe2.subscriptions.retrieve(inv.subscription);
            await sb.from('profiles').update({
              has_membership: true,
              membership_expires_at: new Date(sub.current_period_end * 1000).toISOString(),
            }).eq('id', profiles[0].id);
          }
        }
        break;
      }

      // ── Stripe Connect account capability updates ──
      case 'account.updated': {
        const acct = event.data.object;
        if (!acct?.id) break;

        const updates = {
          stripe_connect_details_submitted: !!acct.details_submitted,
          stripe_connect_charges_enabled: !!acct.charges_enabled,
          stripe_connect_payouts_enabled: !!acct.payouts_enabled,
          stripe_connect_onboarding_complete: !!(acct.details_submitted && acct.charges_enabled && acct.payouts_enabled),
          stripe_connect_updated_at: new Date().toISOString(),
        };

        const { error: connectErr } = await sb
          .from('profiles')
          .update(updates)
          .eq('stripe_connect_account_id', acct.id)
          .eq('role', 'assembler');

        if (connectErr) {
          console.error('Connect account update sync failed:', connectErr.message);
        }
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    webhookOutcome = 'failed';
    webhookError = err?.message || 'Unhandled webhook handler error';
    // Still return 200 to prevent Stripe retries for logic errors
    await finalizeStripeWebhookEvent(sb, event.id, {
      bookingId: webhookBookingId,
      paymentIntentId: webhookPaymentIntentId,
      status: webhookOutcome,
      metadata: webhookMetadata,
      error: webhookError,
    });
    return res.status(200).json({ received: true, warning: 'Handler error logged' });
  }

  await finalizeStripeWebhookEvent(sb, event.id, {
    bookingId: webhookBookingId,
    paymentIntentId: webhookPaymentIntentId,
    status: webhookOutcome,
    metadata: webhookMetadata,
    error: webhookError,
  });

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
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">A receipt was also sent to your card on file via Stripe. Questions? Contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}

function buildOwnerCaptureEmail(booking, amountDisplay) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr>
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
    <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">If you'd like to resolve this directly, contact us at <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>
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
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr>
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

function buildApplicantVerifiedEmail(firstName) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#166534">Identity verified, ${esc(firstName)}.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Stripe identity verification has been submitted successfully. AssembleAtEase will now review your application and email you with the next decision.</p>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">No further action is needed from you right now.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildAssemblerFailEmail(firstName, reason, resumeUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Action required, ${esc(firstName)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Your identity verification could not be completed. Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Use the secure AssembleAtEase link below to retry. If the Stripe page expires or you switch devices, use this same link again.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:#00BFFF;border-radius:8px"><a href="${esc(resumeUrl)}" style="display:inline-block;padding:12px 28px;color:#001f2b;font-size:14px;font-weight:800;text-decoration:none;border-radius:8px">Retry Identity Verification</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply to this email or contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildPaymentFailEmail(firstName, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Payment issue, ${esc(firstName)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">We were unable to process your $30 application fee. Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0 0 0;font-size:14px;color:#52525b;line-height:1.6">Please contact us at <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a> to retry.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildBookingConfirmEmail(booking, totalDisplay) {
  const firstName = esc((booking.customer_name || '').split(' ')[0]);
  const paymentNote = `Your payment method has been verified securely for <strong>${totalDisplay}</strong>. Payment is processed after the job is complete.`;
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
      <strong>Need to change plans?</strong> Reply to this email. Cancel at least 24 hours before your appointment for a full release. Inside 24 hours, a late-cancel fee may apply because a pro has already reserved the time.
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a">Questions? Reply to this email or contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>
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
    <p style="margin:0;font-size:14px;color:#52525b;line-height:1.6">Please contact us at <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a> to rebook with a different card.</p>
  </td></tr></table>
</div></body></html>`;
}
