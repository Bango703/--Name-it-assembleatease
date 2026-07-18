import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { claimStripeWebhookEvent, finalizeStripeWebhookEvent, writeFinancialAudit } from '../_financial-audit.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { validateBookingPaymentIntent } from '../booking/_pending-payment-recovery.js';
import {
  buildIdentityResumeUrl,
  ensureIdentityResumeToken,
  updateProfileRequired,
} from '../_assembler-onboarding.js';
import {
  EASER_APPLICATION_FEE_CENTS,
  EASER_APPLICATION_FEE_DISPLAY,
  validateEaserApplicationPaymentIntent,
} from '../_easer-application-fee.js';
import {
  holdEaserApplicationFeeRefund,
  loadEaserApplicationFeeDisputeTruth,
  loadEaserApplicationFeeRefundTruth,
  reconcileEaserApplicationFeeRefund,
} from '../_easer-application-refund.js';
import { isEaserMembershipEnabled } from '../_easer-membership.js';
import { finalizeEaserApplicationSubmission } from './apply.js';
import { loadBookingStripeRefundTruth, refundPaymentStatus } from '../booking/_stripe-refund-truth.js';
import { reconcileRefundAssembleCash } from '../booking/_refund-credits.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const STRIPE_DISPUTE_STATUSES = new Set([
  'warning_needs_response', 'warning_under_review', 'warning_closed',
  'needs_response', 'under_review', 'won', 'lost', 'prevented',
]);

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
  if (!claim.claimed && !claim.duplicate) {
    console.error('Stripe webhook claim failed:', claim.reason, claim.error || 'unknown claim error');
    return res.status(503).json({ received: false, error: 'Webhook event could not be claimed for safe processing' });
  }
  if (claim.duplicate) {
    const { data: prior, error: priorError } = await sb.from('financial_event_audit')
      .select('id, status, processed_at')
      .eq('stripe_event_id', event.id)
      .maybeSingle();
    if (priorError || !prior) {
      console.error('Stripe webhook duplicate claim lookup failed:', priorError?.message || 'claim row missing');
      return res.status(503).json({ received: false, error: 'Webhook claim state could not be verified' });
    }
    if (['processed', 'ignored'].includes(prior.status)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    let reclaimQuery = sb.from('financial_event_audit').update({
      status: 'processing', error: null, processed_at: new Date().toISOString(),
    }).eq('stripe_event_id', event.id);
    if (prior.status === 'failed') {
      reclaimQuery = reclaimQuery.eq('status', 'failed');
    } else if (prior.status === 'processing') {
      reclaimQuery = reclaimQuery.eq('status', 'processing').lt('processed_at', staleBefore);
    } else {
      return res.status(503).json({ received: false, error: 'Webhook claim has an unknown status (' + (prior.status || 'missing') + ')' });
    }
    const { data: reclaimedRows, error: reclaimError } = await reclaimQuery.select('id');
    if (reclaimError || !reclaimedRows?.length) {
      return res.status(503).json({
        received: false,
        error: prior.status === 'processing'
          ? 'Webhook event is still processing and must be retried'
          : 'Failed webhook event could not be reclaimed',
      });
    }
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

        const { data: profile, error: profileError } = await sb.from('profiles')
          .select('full_name, email, stripe_identity_session_id')
          .eq('id', userId)
          .maybeSingle();
        if (profileError || !profile) {
          throw new Error(`Verified Easer profile lookup failed: ${profileError?.message || 'profile not found'}`);
        }
        if (profile.stripe_identity_session_id && profile.stripe_identity_session_id !== session.id) {
          webhookMetadata = { ...webhookMetadata, ignored: true, reason: 'stale-identity-session', sessionId: session.id };
          break;
        }

        await updateProfileRequired(sb, userId, {
          identity_verified: true,
          identity_verified_at: new Date().toISOString(),
          id_verification_status: 'verified',
          stripe_identity_session_id: session.id,
          identity_resume_token: null,
          identity_resume_token_created_at: null,
          identity_resume_token_expires_at: null,
        }, 'Stripe Identity verified state');

        // Notify owner
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

        const { data: profile, error: profileError } = await sb.from('profiles')
          .select('full_name, email, stripe_identity_session_id')
          .eq('id', userId)
          .maybeSingle();
        if (profileError || !profile) {
          throw new Error(`Retry Easer profile lookup failed: ${profileError?.message || 'profile not found'}`);
        }
        if (profile.stripe_identity_session_id && profile.stripe_identity_session_id !== session.id) {
          webhookMetadata = { ...webhookMetadata, ignored: true, reason: 'stale-identity-session', sessionId: session.id };
          break;
        }

        await updateProfileRequired(sb, userId, {
          identity_verified: false,
          id_verification_status: 'failed',
          stripe_identity_session_id: session.id,
        }, 'Stripe Identity retry state');
        const resumeToken = await ensureIdentityResumeToken(sb, { id: userId }, { rotate: true });
        const resumeUrl = buildIdentityResumeUrl(resumeToken);

        // Notify both owner and assembler
        if (profile) {
          const lastError = session.last_error?.reason || 'verification could not be completed';
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
          const { data: applicationProfile, error: applicationProfileError } = await sb
            .from('profiles')
            .select('id, role, status, application_status, full_name, email, application_fee_paid, payment_confirmed, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, stripe_customer_id, stripe_payment_intent_id')
            .eq('id', userId)
            .maybeSingle();
          if (applicationProfileError || !applicationProfile || applicationProfile.role !== 'assembler') {
            throw new Error(applicationProfileError?.message || 'Application-fee webhook profile was not found');
          }
          if (!['payment_pending', 'applied'].includes(String(applicationProfile.application_status || '').toLowerCase())) {
            webhookOutcome = 'ignored';
            webhookMetadata = {
              ...webhookMetadata,
              reason: 'stale-application-fee-success',
              applicationStatus: applicationProfile.application_status || null,
            };
            break;
          }
          if (!applicationProfile.stripe_customer_id
              || applicationProfile.stripe_payment_intent_id !== pi.id) {
            throw new Error('Application-fee webhook does not match the stored Stripe identifiers');
          }
          // Independently confirm Stripe truth before finalizing: type, canonical
          // fee amount, currency, customer binding, succeeded capture, and consent.
          // The success handler is an authoritative finalization path, so it must
          // not trust the identity binding alone.
          validateEaserApplicationPaymentIntent(pi, {
            userId,
            paymentIntentId: applicationProfile.stripe_payment_intent_id,
            customerId: applicationProfile.stripe_customer_id,
            requireSucceeded: true,
            requireConsent: true,
          });
          const refundSync = await syncEaserApplicationFeeRefund({
            sb,
            stripe,
            event,
            paymentIntentId: pi.id,
            expectedChargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id || null,
            forceHold: false,
            reason: 'Payment confirmation checked fresh application-fee refund truth',
          });
          if (!refundSync.handled) throw new Error('Application-fee Stripe identifiers no longer map to an Easer profile');
          if (refundSync.holdRequired) {
            webhookOutcome = 'ignored';
            webhookMetadata = {
              ...webhookMetadata,
              reason: 'application-fee-refund-blocks-stale-success',
              refundedCents: refundSync.truth?.succeededRefundedCents || 0,
              pendingRefundCents: refundSync.truth?.pendingRefundCents || 0,
            };
            break;
          }
          const { data: paidProfile, error: paidProfileError } = await sb
            .from('profiles')
            .update({
              payment_confirmed: true,
              application_fee_paid: true,
            })
            .eq('id', userId)
            .eq('stripe_payment_intent_id', pi.id)
            .eq('stripe_customer_id', applicationProfile.stripe_customer_id)
            .eq('application_fee_waived', false)
            .eq('fee_waived_by_owner', false)
            .eq('application_fee_refunded', false)
            .eq('application_fee_refunded_cents', 0)
            .eq('application_fee_refund_pending_cents', 0)
            .is('application_fee_refund_review_required_at', null)
            .select('id')
            .maybeSingle();
          if (paidProfileError || !paidProfile) {
            throw new Error(`Application-fee webhook truth persistence failed: ${paidProfileError?.message || 'profile changed'}`);
          }
          await logActivity(sb, {
            bookingId: null,
            eventType: 'assembler_application_fee_confirmed',
            actorType: 'stripe',
            actorId: userId,
            actorName: 'Stripe',
            description: 'Stripe confirmed the Easer application fee.',
            metadata: { paymentIntentId: pi.id, amountReceived: pi.amount_received, currency: pi.currency },
          });
          await finalizeEaserApplicationSubmission({
            sb,
            userId,
            expectedPaymentIntentId: pi.id,
            stripeClient: stripe,
          });
          break;
        }
        if (['customer_booking', 'customer_booking_balance', 'customer_quote', 'reauth'].includes(pi.metadata?.type)) {
          const captureSync = await syncCapturedCustomerPayment({ sb, stripe, pi, event });
          webhookBookingId = captureSync.bookingId;
          webhookPaymentIntentId = pi.id;
          webhookOutcome = captureSync.outcome;
          webhookError = captureSync.error;
          webhookMetadata = { ...webhookMetadata, ...captureSync.metadata };
        }
        break;
      }

      // ── Customer booking: card authorized (requires_capture) ──
      case 'payment_intent.amount_capturable_updated': {
        const pi = event.data.object;
        if (pi.metadata?.type === 'customer_quote') {
          const quoteSync = await syncAuthorizedCustomerQuote({ sb, stripe, pi, event });
          webhookBookingId = quoteSync.bookingId;
          webhookPaymentIntentId = pi.id;
          webhookOutcome = quoteSync.outcome;
          webhookError = quoteSync.error;
          webhookMetadata = { ...webhookMetadata, ...quoteSync.metadata };
          break;
        }
        if (pi.metadata?.type !== 'customer_booking') break;

        const { bookingId } = pi.metadata;
        if (!bookingId) break;
        webhookBookingId = bookingId;
        webhookPaymentIntentId = pi.id;

        const { data: existing, error: existingError } = await sb.from('bookings')
          .select('id, ref, payment_status, status, payment_authorized_at, confirmed_at, dispatch_status, customer_name, customer_email, service, address, date, time, total_price, deposit_amount, is_deposit, assembler_id, stripe_payment_intent_id, financial_operation_key, financial_operation_type')
          .eq('id', bookingId)
          .maybeSingle();

        if (existingError) {
          webhookOutcome = 'failed';
          webhookError = existingError.message || 'Authorized booking lookup failed';
          break;
        }
        if (!existing) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found', bookingId };
          break;
        }
        if (existing.financial_operation_key) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'financial-operation-will-reconcile-authorization', bookingId, financialOperationType: existing.financial_operation_type || null };
          break;
        }

        if (['captured', 'cancellation_fee_captured', 'partially_refunded', 'refunded', 'deposit_paid'].includes(existing.payment_status)) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'stale-authorize-event', bookingId, currentPaymentStatus: existing.payment_status };
          break;
        }

        const liveAuthorization = await stripe.paymentIntents.retrieve(pi.id);
        if (liveAuthorization.id !== pi.id || liveAuthorization.metadata?.bookingId !== bookingId) {
          webhookOutcome = 'failed';
          webhookError = 'Stripe authorization no longer matches the event booking';
          webhookMetadata = { ...webhookMetadata, reason: 'authorization-live-link-mismatch', bookingId };
          break;
        }
        if (liveAuthorization.status !== 'requires_capture') {
          webhookOutcome = 'ignored';
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'stale-authorization-status',
            bookingId,
            liveStatus: liveAuthorization.status || null,
          };
          break;
        }

        const paymentValidation = validateBookingPaymentIntent(existing, liveAuthorization);
        if (!paymentValidation.ok) {
          webhookOutcome = 'failed';
          webhookError = `Stripe authorization did not match booking truth: ${paymentValidation.errors.join(', ')}`;
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'authorization-validation-failed',
            bookingId,
            validationErrors: paymentValidation.errors,
            stripeStatus: liveAuthorization.status || null,
          };
          break;
        }

        if (existing.payment_status === 'authorized' && existing.status === 'confirmed') {
          if (existing.status === 'confirmed' && !existing.assembler_id) {
            try {
              const retry = await dispatchBooking(bookingId);
              webhookMetadata = { ...webhookMetadata, dispatchRetry: retry };
            } catch (err) {
              console.error('webhook dispatch retry error:', err?.message || err);
              webhookMetadata = { ...webhookMetadata, dispatchRetryError: err?.message || String(err) };
            }
          }
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'already-authorized', bookingId, currentPaymentStatus: existing.payment_status, currentStatus: existing.status };
          break;
        }

        const repairableBookingStatuses = ['pending', 'confirmed'];
        const repairablePaymentStatuses = ['pending', 'failed', 'authorized'];
        if (!repairableBookingStatuses.includes(existing.status)
            || !repairablePaymentStatuses.includes(existing.payment_status)) {
          webhookOutcome = 'ignored';
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'authorization-state-not-repairable',
            bookingId,
            currentPaymentStatus: existing.payment_status,
            currentStatus: existing.status,
          };
          break;
        }

        const paymentMethodId = typeof liveAuthorization.payment_method === 'string'
          ? liveAuthorization.payment_method
          : liveAuthorization.payment_method?.id || null;
        const authorizedAt = new Date().toISOString();
        // Repair either half of the confirmed/authorized state pair. Stripe is
        // validated first, and the linked PaymentIntent participates in the CAS.
        const authorizationUpdate = {
          payment_status: 'authorized',
          payment_authorized_at: existing.payment_authorized_at || authorizedAt,
          stripe_payment_method_id: paymentMethodId,
          status: 'confirmed',
          confirmed_at: existing.confirmed_at || authorizedAt,
          confirmed_by: 'stripe_webhook',
          ...(existing.dispatch_status === 'payment_hold' ? {
            dispatch_status: null,
            dispatch_paused: false,
            needs_manual_dispatch: false,
          } : {}),
        };
        const { error: authErr, data: authRows } = await sb.from('bookings').update(authorizationUpdate)
          .eq('id', bookingId)
          .eq('status', existing.status)
          .eq('payment_status', existing.payment_status)
          .eq('stripe_payment_intent_id', pi.id)
          .is('financial_operation_key', null)
          .select('id');

        if (authErr) {
          webhookOutcome = 'failed';
          webhookError = authErr.message || 'Failed to sync authorized status';
          break;
        }
        if (!authRows || authRows.length === 0) {
          const { data: current } = await sb.from('bookings')
            .select('status, payment_status, stripe_payment_intent_id, assembler_id')
            .eq('id', bookingId)
            .maybeSingle();
          if (current?.status === 'confirmed'
              && current?.payment_status === 'authorized'
              && current?.stripe_payment_intent_id === pi.id) {
            if (!current.assembler_id) {
              try {
                const retry = await dispatchBooking(bookingId);
                webhookMetadata = { ...webhookMetadata, dispatchRetry: retry };
              } catch (err) {
                console.error('webhook concurrent dispatch retry error:', err?.message || err);
                webhookMetadata = { ...webhookMetadata, dispatchRetryError: err?.message || String(err) };
              }
            }
            webhookOutcome = 'ignored';
            webhookMetadata = { ...webhookMetadata, reason: 'authorization-concurrently-reconciled', bookingId };
            break;
          }
          webhookOutcome = 'failed';
          webhookError = 'Stripe is authorized, but the booking state could not be reconciled';
          webhookMetadata = { ...webhookMetadata, reason: 'authorization-cas-failed', bookingId };
          break;
        }

        try {
          const dispatchResult = await dispatchBooking(bookingId);
          webhookMetadata = { ...webhookMetadata, dispatchResult };
        } catch (err) {
          console.error('webhook dispatch error:', err?.message || err);
          webhookMetadata = { ...webhookMetadata, dispatchError: err?.message || String(err) };
        }

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

      // ── Payment: failed ──
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        webhookPaymentIntentId = pi.id;

        // Assembler application fee failure
        if (pi.metadata?.type === 'assembler_application_fee') {
          const userId = pi.metadata?.userId;
          if (!userId) break;
          const { data: profile, error: profileError } = await sb.from('profiles')
            .select('full_name, email, role, stripe_customer_id, stripe_payment_intent_id')
            .eq('id', userId)
            .maybeSingle();
          if (profileError || !profile || profile.role !== 'assembler'
              || !profile.stripe_customer_id
              || profile.stripe_payment_intent_id !== pi.id) {
            throw new Error(profileError?.message || 'Failed application-fee event does not match a stored Easer payment');
          }
          validateEaserApplicationPaymentIntent(pi, {
            userId,
            paymentIntentId: profile.stripe_payment_intent_id,
            customerId: profile.stripe_customer_id,
          });
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

        // Customer booking/quote failure. Stripe events can arrive out of order,
        // so retrieve live truth and mutate only the exact currently linked PI.
        if (['customer_booking', 'customer_quote', 'reauth'].includes(pi.metadata?.type)) {
          const { bookingId } = pi.metadata;
          if (!bookingId) break;
          webhookBookingId = bookingId;

          const { data: currentBooking, error: bookingLookupError } = await sb.from('bookings')
            .select('id, payment_status, status, customer_name, customer_email, ref, service, total_price, quote_amount_cents, stripe_payment_intent_id, financial_operation_key, financial_operation_type')
            .eq('id', bookingId)
            .maybeSingle();

          if (bookingLookupError) throw new Error(`Failed-payment booking lookup failed: ${bookingLookupError.message}`);
          if (!currentBooking) {
            webhookOutcome = 'ignored';
            webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found', bookingId };
            break;
          }
          if (['cancelled', 'declined', 'completed', 'refunded'].includes(currentBooking.status)
              || currentBooking.financial_operation_key) {
            webhookOutcome = 'ignored';
            webhookMetadata = {
              ...webhookMetadata,
              reason: currentBooking.financial_operation_key ? 'financial-operation-will-reconcile-failure' : 'terminal-booking-payment-failure',
              bookingId,
              currentStatus: currentBooking.status,
              financialOperationType: currentBooking.financial_operation_type || null,
            };
            break;
          }
          if (currentBooking.stripe_payment_intent_id !== pi.id) {
            webhookOutcome = 'ignored';
            webhookMetadata = { ...webhookMetadata, reason: 'stale-payment-failed-intent', bookingId, currentPaymentIntentId: currentBooking.stripe_payment_intent_id };
            break;
          }

          const liveIntent = await stripe.paymentIntents.retrieve(pi.id);
          if (['requires_capture', 'succeeded'].includes(liveIntent.status)) {
            webhookOutcome = 'ignored';
            webhookMetadata = { ...webhookMetadata, reason: 'stale-payment-failed-event', bookingId, liveStatus: liveIntent.status };
            break;
          }

          const expectedAmount = Number(
            pi.metadata?.type === 'customer_quote'
              ? currentBooking.quote_amount_cents
              : currentBooking.total_price,
          );
          const typeMatches = liveIntent.metadata?.type === pi.metadata?.type
            || (pi.metadata?.type === 'reauth' && liveIntent.metadata?.type === 'reauth');
          if (liveIntent.id !== currentBooking.stripe_payment_intent_id
              || liveIntent.metadata?.bookingId !== currentBooking.id
              || !typeMatches
              || liveIntent.currency !== 'usd'
              || liveIntent.capture_method !== 'manual'
              || !Number.isInteger(expectedAmount)
              || expectedAmount <= 0
              || liveIntent.amount !== expectedAmount) {
            throw new Error('Failed PaymentIntent does not match current booking truth');
          }

          if (['captured', 'deposit_paid', 'refund_pending', 'refunded', 'partially_refunded', 'cancellation_fee_captured', 'authorization_released'].includes(currentBooking.payment_status)) {
            webhookOutcome = 'ignored';
            webhookMetadata = {
              ...webhookMetadata,
              reason: 'stale-payment-failed',
              bookingId,
              currentPaymentStatus: currentBooking.payment_status,
            };
            break;
          }

          const isQuote = pi.metadata?.type === 'customer_quote';
          const failureUpdate = isQuote
            ? { payment_status: 'quote_pending_approval' }
            : { payment_status: 'failed', dispatch_paused: true, needs_manual_dispatch: false, dispatch_status: 'payment_hold' };
          const { data: failedRows, error: failedUpdateError } = await sb.from('bookings')
            .update(failureUpdate)
            .eq('id', bookingId)
            .eq('stripe_payment_intent_id', pi.id)
            .eq('payment_status', currentBooking.payment_status)
            .is('financial_operation_key', null)
            .is('financial_operation_type', null)
            .is('financial_operation_started_at', null)
            .select('id');
          if (failedUpdateError) {
            throw new Error(`Failed-payment state persistence failed: ${failedUpdateError.message}`);
          }
          if (!failedRows?.length) {
            webhookOutcome = 'ignored';
            webhookMetadata = {
              ...webhookMetadata,
              reason: 'financial-operation-reserved-during-webhook',
              bookingId,
              paymentIntentId: pi.id,
            };
            break;
          }

          const { error: offerCancelError } = await sb.from('dispatch_offers')
            .update({ offer_status: 'cancelled' })
            .eq('booking_id', bookingId)
            .eq('offer_status', 'sent');
          if (offerCancelError) throw new Error(`Failed-payment offer cleanup failed: ${offerCancelError.message}`);

          await logActivity(sb, {
            bookingId,
            eventType: 'payment_failed',
            actorType: 'system',
            actorName: 'stripe_webhook',
            description: `Stripe reported payment failure: ${pi.last_payment_error?.message || 'Card authorization failed'}`,
            metadata: { stripeEventId: event.id, paymentIntentId: pi.id },
          });

          const reason = pi.last_payment_error?.message || 'Card could not be authorized.';

          if (currentBooking.customer_email) {
            // Notify customer
            try {
              await sendEmail({
                to: currentBooking.customer_email,
                from: 'AssembleAtEase <booking@assembleatease.com>',
                subject: `Action needed: we couldn't confirm your card — ${esc(currentBooking.ref)}`,
                html: buildCustomerPaymentFailEmail((currentBooking.customer_name || 'Customer').split(' ')[0], currentBooking.ref, reason),
                replyTo: ownerEmail(),
                meta: { bookingId, notificationType: 'payment_failed_customer', recipientType: 'customer' },
              });
            } catch (e) { console.error('Customer payment fail email error:', e); }
          }

          // #23 — Owner payment failed notification (branded)
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Payment Failed — ${esc(currentBooking.ref || bookingId)}`,
              html: buildOwnerPaymentFailEmail(currentBooking.ref || bookingId, reason, currentBooking.customer_name),
              meta: { bookingId, notificationType: 'payment_failed_owner', recipientType: 'owner' },
            });
          } catch (e) { console.error('Owner payment fail email error:', e); }
        }
        break;
      }

      // ── Payment authorization released/canceled ──
      case 'payment_intent.canceled': {
        const pi = event.data.object;
        if (!['customer_booking', 'customer_quote', 'reauth'].includes(pi.metadata?.type)) break;
        const bookingId = pi.metadata?.bookingId;
        if (!bookingId) break;
        webhookBookingId = bookingId;
        webhookPaymentIntentId = pi.id;

        const { data: booking, error: bookingError } = await sb.from('bookings')
          .select('id, ref, service, status, payment_status, customer_name, customer_email, stripe_payment_intent_id, financial_operation_key, financial_operation_type')
          .eq('id', bookingId)
          .maybeSingle();
        if (bookingError) throw new Error(`Canceled-payment booking lookup failed: ${bookingError.message}`);
        if (!booking) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found-for-canceled-payment', bookingId };
          break;
        }
        if (booking.financial_operation_key) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'financial-operation-will-reconcile-cancellation', bookingId, financialOperationType: booking.financial_operation_type || null };
          break;
        }
        if (booking.stripe_payment_intent_id !== pi.id) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'stale-canceled-payment-intent', bookingId, currentPaymentIntentId: booking.stripe_payment_intent_id };
          break;
        }
        if (['cancelled', 'declined', 'completed', 'refunded'].includes(booking.status)
            || ['captured', 'deposit_paid', 'refunded', 'partially_refunded'].includes(booking.payment_status)) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'expected-or-stale-payment-cancellation', bookingId, currentStatus: booking.status, currentPaymentStatus: booking.payment_status };
          break;
        }

        const isQuote = pi.metadata?.type === 'customer_quote';
        const canceledUpdate = isQuote
          ? { stripe_payment_intent_id: null, payment_status: 'quote_pending_approval', quote_approval_started_at: null }
          : { payment_status: 'failed', dispatch_paused: true, needs_manual_dispatch: false, dispatch_status: 'payment_hold' };
        const { data: canceledRows, error: canceledUpdateError } = await sb.from('bookings')
          .update(canceledUpdate)
          .eq('id', booking.id)
          .eq('stripe_payment_intent_id', pi.id)
          .eq('status', booking.status)
          .eq('payment_status', booking.payment_status)
          .is('financial_operation_key', null)
          .is('financial_operation_type', null)
          .is('financial_operation_started_at', null)
          .select('id');
        if (canceledUpdateError) {
          throw new Error(`Canceled-payment state persistence failed: ${canceledUpdateError.message}`);
        }
        if (!canceledRows?.length) {
          webhookOutcome = 'ignored';
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'financial-operation-reserved-during-webhook',
            bookingId,
            paymentIntentId: pi.id,
          };
          break;
        }

        const { error: canceledOffersError } = await sb.from('dispatch_offers')
          .update({ offer_status: 'cancelled' })
          .eq('booking_id', booking.id)
          .eq('offer_status', 'sent');
        if (canceledOffersError) throw new Error(`Canceled-payment offer cleanup failed: ${canceledOffersError.message}`);

        await logActivity(sb, {
          bookingId: booking.id,
          eventType: 'payment_authorization_canceled',
          actorType: 'stripe',
          actorName: 'Stripe',
          description: `${booking.ref} card authorization was released; dispatch is blocked until payment is restored`,
          metadata: { stripeEventId: event.id, paymentIntentId: pi.id, cancellationReason: pi.cancellation_reason || null },
        });

        await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Payment Hold Released - ${esc(booking.ref)}`,
          html: `<p>Stripe canceled the current card authorization for <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}).</p><p>Dispatch is blocked. Review the booking timeline, then send a secure payment continuation or new quote approval link. Do not assign an Easer until payment is verified.</p>`,
          meta: { bookingId: booking.id, notificationType: 'payment_authorization_canceled_owner', recipientType: 'owner' },
        }).catch(error => console.error('Canceled payment owner email failed:', error?.message || error));
        break;
      }

      // ── Refund sync: keep booking truth aligned to Stripe refund truth ──
      case 'refund.created':
      case 'refund.failed':
      case 'refund.updated': {
        const refund = event.data.object;
        const paymentIntentId = typeof refund.payment_intent === 'string' ? refund.payment_intent : null;
        if (!paymentIntentId) break;
        webhookPaymentIntentId = paymentIntentId;
        const refundStatus = String(refund.status || '').toLowerCase();
        const applicationRefundSync = await syncEaserApplicationFeeRefund({
          sb,
          stripe,
          event,
          paymentIntentId,
          expectedChargeId: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id || null,
          forceHold: !['failed', 'canceled'].includes(refundStatus),
          reason: `Stripe application-fee refund ${refund.id || 'unknown'} is ${refundStatus || 'unknown'}`,
        });
        if (applicationRefundSync.handled) {
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'application-fee-refund-synchronized',
            refundId: refund.id || null,
            refundStatus: refund.status || null,
            refundedCents: applicationRefundSync.truth?.succeededRefundedCents || 0,
            pendingRefundCents: applicationRefundSync.truth?.pendingRefundCents || 0,
            newJobsBlocked: applicationRefundSync.holdRequired,
          };
          break;
        }
        if (!['failed', 'canceled'].includes(refundStatus)) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'refund-update-awaiting-charge-sync', refundStatus: refund.status || null, refundId: refund.id || null };
          break;
        }
        const { data: booking, error: refundFailureLookupError } = await sb.from('bookings')
          .select('id, ref, refund_amount, financial_operation_key, financial_operation_type, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_balance_payment_intent_id')
          .or(`stripe_payment_intent_id.eq.${paymentIntentId},stripe_deposit_intent_id.eq.${paymentIntentId},stripe_balance_payment_intent_id.eq.${paymentIntentId}`)
          .maybeSingle();
        if (refundFailureLookupError) throw new Error(`Failed-refund booking lookup failed: ${refundFailureLookupError.message}`);
        if (!booking) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'booking-not-found-for-failed-refund', paymentIntentId, refundId: refund.id || null };
          break;
        }
        webhookBookingId = booking.id;
        const stripeTruth = await loadBookingStripeRefundTruth({ stripe, booking });
        const expectedOperationKey = `refund:owner:${booking.id}:total:${stripeTruth.capturedCents}`;
        const storedRefundCents = Number(booking.refund_amount || 0);
        const matchingRefundLock = booking.financial_operation_type === 'refund_owner'
          && booking.financial_operation_key === expectedOperationKey;
        await logActivity(sb, {
          bookingId: booking.id,
          eventType: 'refund_failed',
          actorType: 'stripe',
          actorName: 'Stripe',
          description: `${booking.ref} refund ${refund.id || ''} failed; any owner refund lock remains unchanged until fresh aggregate Stripe truth is reconciled`,
          metadata: {
            stripeEventId: event.id,
            paymentIntentId,
            refundId: refund.id || null,
            failureReason: refund.failure_reason || null,
            releasedLock: false,
            matchingRefundLock,
            stripeRefundedCents: stripeTruth.refundedCents,
            stripePendingRefundCents: stripeTruth.pendingRefundCents,
            storedRefundCents,
          },
        });
        await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Refund Failed - ${esc(booking.ref)}`,
          html: `<p>Stripe reports that refund <strong>${esc(refund.id || 'unknown')}</strong> for booking <strong>${esc(booking.ref)}</strong> failed.</p><p>Review the aggregate refund in Stripe before retrying. A webhook never releases an owner refund lock because this event may belong to an older attempt. Retry only from the owner booking action, which rechecks fresh Stripe truth first.</p>`,
          meta: { bookingId: booking.id, notificationType: 'refund_failed_owner', recipientType: 'owner' },
        }).catch(error => console.error('Refund failure owner email failed:', error?.message || error));
        webhookMetadata = { ...webhookMetadata, reason: 'refund-failure-synchronized', refundId: refund.id || null, releasedLock: false, matchingRefundLock };
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        if (!paymentIntentId) break;

        webhookPaymentIntentId = paymentIntentId;

        const applicationRefundSync = await syncEaserApplicationFeeRefund({
          sb,
          stripe,
          event,
          paymentIntentId,
          expectedChargeId: charge.id || null,
          forceHold: true,
          reason: `Stripe application-fee charge ${charge.id || 'unknown'} was refunded`,
        });
        if (applicationRefundSync.handled) {
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'application-fee-refund-synchronized',
            refundedCents: applicationRefundSync.truth?.succeededRefundedCents || 0,
            pendingRefundCents: applicationRefundSync.truth?.pendingRefundCents || 0,
            fullyRefunded: applicationRefundSync.truth?.fullyRefunded === true,
            newJobsBlocked: true,
          };
          break;
        }

        const { data: booking, error: refundBookingError } = await sb.from('bookings')
          .select('id, ref, status, payment_status, amount_charged, refund_id, refund_amount, assembler_id, assembler_name, assembler_due, payout_status, payout_amount, financial_operation_key, financial_operation_type, financial_operation_started_at, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_balance_payment_intent_id')
          .or(`stripe_payment_intent_id.eq.${paymentIntentId},stripe_deposit_intent_id.eq.${paymentIntentId},stripe_balance_payment_intent_id.eq.${paymentIntentId}`)
          .maybeSingle();

        if (refundBookingError) throw new Error(`Refund booking lookup failed: ${refundBookingError.message}`);

        if (!booking) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'booking-or-application-not-found-for-refund', paymentIntentId };
          break;
        }

        webhookBookingId = booking.id;

        const stripeTruth = await loadBookingStripeRefundTruth({ stripe, booking });
        const cumulativeRefund = stripeTruth.refundedCents;
        const capturedAmount = stripeTruth.capturedCents;
        const storedRefund = Number(booking.refund_amount || 0);
        if (storedRefund > cumulativeRefund) {
          throw new Error(`Booking refund total (${storedRefund}) exceeds current aggregate Stripe truth (${cumulativeRefund})`);
        }
        if (cumulativeRefund <= 0 || capturedAmount <= 0) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'no-succeeded-refund-in-stripe-truth', paymentIntentId };
          break;
        }
        const refundPaymentState = refundPaymentStatus(stripeTruth);
        const easerReviewRequired = booking.status === 'completed'
          && !!booking.assembler_id
          && Number(booking.assembler_due || 0) > 0;
        const expectedRefundOperationKey = `refund:owner:${booking.id}:total:${cumulativeRefund}`;
        const clearRefundLock = booking.financial_operation_type === 'refund_owner'
          && booking.financial_operation_key === expectedRefundOperationKey;
        const refundRows = Array.isArray(charge.refunds?.data) ? charge.refunds.data : [];
        const latestSucceededRefund = refundRows
          .filter(refund => refund.status === 'succeeded')
          .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))[0] || null;
        const refundUpdate = {
          payment_status: refundPaymentState,
          refund_amount: cumulativeRefund,
          refund_id: latestSucceededRefund?.id || booking.refund_id || null,
          refunded_at: event.created ? new Date(event.created * 1000).toISOString() : new Date().toISOString(),
          ...(easerReviewRequired ? {
            payout_review_status: 'review_required',
            payout_reviewed_at: null,
            payout_reviewed_by: null,
            payout_review_notes: null,
          } : {}),
        };
        let refundUpdateQuery = sb.from('bookings').update(refundUpdate).eq('id', booking.id);
        refundUpdateQuery = booking.refund_amount == null
          ? refundUpdateQuery.is('refund_amount', null)
          : refundUpdateQuery.eq('refund_amount', booking.refund_amount);
        refundUpdateQuery = booking.financial_operation_key == null
          ? refundUpdateQuery.is('financial_operation_key', null)
          : refundUpdateQuery.eq('financial_operation_key', booking.financial_operation_key);
        refundUpdateQuery = booking.financial_operation_type == null
          ? refundUpdateQuery.is('financial_operation_type', null)
          : refundUpdateQuery.eq('financial_operation_type', booking.financial_operation_type);
        refundUpdateQuery = booking.financial_operation_started_at == null
          ? refundUpdateQuery.is('financial_operation_started_at', null)
          : refundUpdateQuery.eq('financial_operation_started_at', booking.financial_operation_started_at);
        const { error: refundSyncErr, data: refundSyncRows } = await refundUpdateQuery.select('id');

        if (refundSyncErr || !refundSyncRows?.length) {
          webhookOutcome = 'failed';
          webhookError = refundSyncErr?.message || 'Refund sync state changed before persistence';
          webhookMetadata = { ...webhookMetadata, reason: 'refund-sync-update-failed', paymentIntentId };
          break;
        }

        const rewardsReversal = await reconcileRefundAssembleCash({
          sb,
          booking,
          cumulativeRefundCents: cumulativeRefund,
          eventSource: 'stripe_webhook',
          fullyRefunded: stripeTruth.fullyRefunded,
        });

        await logActivity(sb, {
          bookingId: booking.id,
          eventType: 'refunded',
          actorType: 'system',
          actorName: 'stripe_webhook',
          description: `Stripe webhook aggregate refund sync: $${(cumulativeRefund / 100).toFixed(2)}`,
          metadata: { stripeEventId: event.id, paymentIntentId, amountRefunded: cumulativeRefund, capturedAmount, paymentStatus: refundPaymentState },
        });

        const refundAudit = await writeFinancialAudit(sb, {
          eventType: 'refund_sync',
          eventSource: 'stripe_webhook',
          bookingId: booking.id,
          paymentIntentId,
          status: 'processed',
          idempotencyKey: `refund-sync:${booking.id}:total:${cumulativeRefund}`,
          eventCreatedAt: event.created ? new Date(event.created * 1000).toISOString() : null,
          metadata: { amountRefunded: cumulativeRefund, capturedAmount, chargeId: charge.id || null, stripeEventId: event.id },
        });
        if (!refundAudit?.ok) throw new Error(`Refund financial audit failed: ${refundAudit?.error || 'unknown error'}`);

        if (['paid', 'transferred'].includes(booking.payout_status)) {
          const clawbackKey = `clawback:${booking.id}:refund-total:${cumulativeRefund}`;
          const { data: existingClawback, error: clawbackLookupError } = await sb.from('financial_event_audit')
            .select('id')
            .eq('idempotency_key', clawbackKey)
            .limit(1)
            .maybeSingle();
          if (clawbackLookupError) throw new Error(`Clawback audit lookup failed: ${clawbackLookupError.message}`);
          if (!existingClawback) {
            const clawbackOwedCents = Math.min(cumulativeRefund, Number(booking.payout_amount || booking.assembler_due || 0));
            const clawbackAudit = await writeFinancialAudit(sb, {
              eventType: 'clawback_required',
              eventSource: 'stripe_webhook',
              bookingId: booking.id,
              paymentIntentId,
              refundId: latestSucceededRefund?.id || null,
              idempotencyKey: clawbackKey,
              status: 'open',
              metadata: {
                ref: booking.ref,
                assemblerId: booking.assembler_id,
                assemblerName: booking.assembler_name || null,
                cumulativeRefundAmountCents: cumulativeRefund,
                payoutAmountCents: booking.payout_amount || 0,
                clawbackOwedCents,
              },
            });
            if (!clawbackAudit?.ok) {
              const { data: racedClawback, error: racedClawbackError } = await sb.from('financial_event_audit')
                .select('id')
                .eq('idempotency_key', clawbackKey)
                .limit(1)
                .maybeSingle();
              if (racedClawbackError || !racedClawback) {
                throw new Error(`Clawback audit failed: ${clawbackAudit?.error || racedClawbackError?.message || 'unknown error'}`);
              }
            }
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Payout Review Required - Refund after payout - ${esc(booking.ref)}`,
              html: `<p>Booking <strong>${esc(booking.ref)}</strong> has an aggregate Stripe refund of <strong>$${(cumulativeRefund / 100).toFixed(2)}</strong>, but the Easer payout is already ${esc(booking.payout_status)}.</p><p>A durable clawback review is open in the Owner dashboard. Do not close this financial record until the recovery or owner adjustment is documented.</p>`,
              meta: { bookingId: booking.id, notificationType: 'refund_clawback_required', recipientType: 'owner' },
            }).catch(error => console.error('Refund clawback owner email failed:', error?.message || error));
          }
        }

        if (!rewardsReversal.ok) {
          const rewardHoldUpdate = {
            financial_reconciliation_required_at: new Date().toISOString(),
            financial_reconciliation_reason: 'AssembleCash could not be reconciled after Stripe completed the refund.',
          };
          if (booking.financial_operation_key == null
              && booking.financial_operation_type == null
              && booking.financial_operation_started_at == null) {
            // External Stripe refunds have no owner reservation. Convert the
            // no-lock hold into the same exact refund tuple used by the owner
            // endpoint so webhook or owner retries are safe and idempotent.
            rewardHoldUpdate.financial_operation_key = expectedRefundOperationKey;
            rewardHoldUpdate.financial_operation_type = 'refund_owner';
            rewardHoldUpdate.financial_operation_started_at = new Date().toISOString();
          }
          let rewardHoldQuery = sb.from('bookings').update(rewardHoldUpdate).eq('id', booking.id);
          rewardHoldQuery = booking.financial_operation_key == null
            ? rewardHoldQuery.is('financial_operation_key', null)
            : rewardHoldQuery.eq('financial_operation_key', booking.financial_operation_key);
          rewardHoldQuery = booking.financial_operation_type == null
            ? rewardHoldQuery.is('financial_operation_type', null)
            : rewardHoldQuery.eq('financial_operation_type', booking.financial_operation_type);
          rewardHoldQuery = booking.financial_operation_started_at == null
            ? rewardHoldQuery.is('financial_operation_started_at', null)
            : rewardHoldQuery.eq('financial_operation_started_at', booking.financial_operation_started_at);
          const { error: rewardHoldError, data: rewardHoldRows } = await rewardHoldQuery.select('id');
          webhookOutcome = 'failed';
          webhookError = rewardsReversal.reconciliation?.error || 'AssembleCash refund reconciliation failed';
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'assemblecash-refund-reconciliation-required',
            paymentIntentId,
            rewardHoldPersisted: !rewardHoldError && !!rewardHoldRows?.length,
          };
          break;
        }

        if (clearRefundLock) {
          const { error: refundReleaseError, data: refundReleaseRows } = await sb.from('bookings').update({
            financial_operation_key: null,
            financial_operation_type: null,
            financial_operation_started_at: null,
            financial_reconciliation_required_at: null,
            financial_reconciliation_reason: null,
          })
            .eq('id', booking.id)
            .eq('financial_operation_key', expectedRefundOperationKey)
            .eq('financial_operation_type', 'refund_owner')
            .select('id');
          if (refundReleaseError || !refundReleaseRows?.length) {
            throw new Error(`Refund lock release failed after rewards reconciliation: ${refundReleaseError?.message || 'reservation changed'}`);
          }
        } else if (!booking.financial_operation_key
            && !booking.financial_operation_type
            && !booking.financial_operation_started_at) {
          await sb.from('bookings').update({
            financial_reconciliation_required_at: null,
            financial_reconciliation_reason: null,
          })
            .eq('id', booking.id)
            .is('financial_operation_key', null)
            .is('financial_operation_type', null)
            .is('financial_operation_started_at', null)
            .eq('financial_reconciliation_reason', 'AssembleCash could not be reconciled after Stripe completed the refund.');
        }

        webhookMetadata = {
          ...webhookMetadata,
          reason: 'aggregate-refund-synchronized',
          cumulativeRefund,
          capturedAmount,
          paymentStatus: refundPaymentState,
          clearedRefundLock: clearRefundLock,
        };

        break;
      }

      // ── Dispute lifecycle — durable payout/new-work hold ──
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated':
      case 'charge.dispute.closed': {
        const eventDispute = event.data.object;
        const eventChargeId = typeof eventDispute.charge === 'string'
          ? eventDispute.charge
          : eventDispute.charge?.id || null;
        if (!eventDispute?.id || !eventChargeId) {
          throw new Error('Stripe dispute event is missing exact identifiers');
        }
        const charge = await stripe.charges.retrieve(eventChargeId);
        const paymentIntentId = typeof charge?.payment_intent === 'string'
          ? charge.payment_intent
          : charge?.payment_intent?.id || null;
        if (!paymentIntentId || charge.id !== eventChargeId) {
          throw new Error('Stripe dispute charge does not have an exact PaymentIntent');
        }
        webhookPaymentIntentId = paymentIntentId;

        const applicationDispute = await syncEaserApplicationFeeDispute({
          sb,
          stripe,
          event,
          dispute: eventDispute,
          charge,
        });
        if (applicationDispute.handled) {
          webhookMetadata = {
            ...webhookMetadata,
            reason: 'application-fee-dispute-held',
            disputeId: eventDispute.id,
            disputeStatus: applicationDispute.disputeTruth?.latestDispute?.status || eventDispute.status || null,
            newJobsBlocked: true,
          };
          break;
        }

        const liveDispute = await stripe.disputes.retrieve(eventDispute.id);
        const liveChargeId = typeof liveDispute?.charge === 'string'
          ? liveDispute.charge
          : liveDispute?.charge?.id || null;
        const liveStatus = String(liveDispute?.status || '').toLowerCase();
        const liveAmount = Number(liveDispute?.amount);
        if (liveDispute?.id !== eventDispute.id
            || liveChargeId !== charge.id
            || !STRIPE_DISPUTE_STATUSES.has(liveStatus)
            || liveDispute.currency !== 'usd'
            || liveDispute.livemode !== charge.livemode
            || !Number.isInteger(liveAmount)
            || liveAmount <= 0
            || liveAmount > Number(charge.amount || 0)) {
          throw new Error('Fresh Stripe dispute truth is inconsistent with its charge');
        }

        const { data: disputeBk, error: disputeBookingError } = await sb.from('bookings')
          .select('id, ref, service, customer_name, customer_email, payout_status, assembler_id, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_balance_payment_intent_id')
          .or(`stripe_payment_intent_id.eq.${paymentIntentId},stripe_deposit_intent_id.eq.${paymentIntentId},stripe_balance_payment_intent_id.eq.${paymentIntentId}`)
          .maybeSingle();
        if (disputeBookingError) throw new Error(`Dispute booking lookup failed: ${disputeBookingError.message}`);
        if (!disputeBk) {
          webhookOutcome = 'ignored';
          webhookMetadata = { ...webhookMetadata, reason: 'dispute-payment-owner-not-found', disputeId: liveDispute.id };
          break;
        }
        webhookBookingId = disputeBk.id;
        const observedAt = event.created
          ? new Date(Number(event.created) * 1000).toISOString()
          : new Date().toISOString();
        const { data: holdRows, error: holdError } = await sb.rpc('hold_booking_stripe_dispute', {
          p_booking_id: disputeBk.id,
          p_payment_intent_id: paymentIntentId,
          p_charge_id: charge.id,
          p_dispute_id: liveDispute.id,
          p_dispute_status: liveStatus,
          p_dispute_amount_cents: liveAmount,
          p_currency: liveDispute.currency,
          p_dispute_reason: liveDispute.reason || null,
          p_livemode: liveDispute.livemode,
          p_funds_withdrawn: event.type === 'charge.dispute.funds_withdrawn',
          p_funds_reinstated: event.type === 'charge.dispute.funds_reinstated',
          p_observed_at: observedAt,
        });
        if (holdError) throw new Error(`Stripe dispute payout hold failed: ${holdError.message}`);
        const hold = Array.isArray(holdRows) ? holdRows[0] : holdRows;
        if (!hold?.result_action) throw new Error('Stripe dispute payout hold returned no authoritative result');
        const { error: disputeOfferCancelError } = await sb.from('dispatch_offers')
          .update({ offer_status: 'cancelled' })
          .eq('booking_id', disputeBk.id)
          .eq('offer_status', 'sent');
        if (disputeOfferCancelError) {
          throw new Error(`Stripe-disputed booking offer cancellation failed: ${disputeOfferCancelError.message}`);
        }

        await logActivity(sb, {
          bookingId: disputeBk.id,
          eventType: 'stripe_dispute_payout_hold',
          actorType: 'stripe',
          actorName: 'Stripe',
          description: `${disputeBk.ref} dispute ${liveDispute.id} is ${liveStatus}; every Easer payout path remains blocked pending fresh resolution review`,
          metadata: {
            stripeEventId: event.id,
            disputeId: liveDispute.id,
            disputeStatus: liveStatus,
            disputeAmountCents: liveAmount,
            paymentIntentId,
            chargeId: charge.id,
            payoutStatus: hold.payout_status || disputeBk.payout_status || null,
            payoutAlreadyReleased: ['paid', 'transferred'].includes(hold.payout_status || disputeBk.payout_status),
          },
        });

        const disputeAmount = `$${(liveAmount / 100).toFixed(2)}`;
        await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `URGENT: Chargeback Dispute - ${disputeAmount} - ${esc(disputeBk.ref)}`,
          html: `${buildOwnerDisputeEmail(liveDispute, disputeAmount, disputeBk)}<p><strong>Easer payout hold:</strong> Active. Do not pay externally. ${['paid', 'transferred'].includes(hold.payout_status || disputeBk.payout_status) ? 'Funds may already have left the platform; review recovery immediately.' : 'Use owner dispute resolution only after fresh Stripe truth is resolved and any withdrawn funds are reinstated.'}</p>`,
          meta: { bookingId: disputeBk.id, notificationType: 'stripe_dispute_owner', recipientType: 'owner' },
        }).catch(error => console.error('Dispute owner email error:', error?.message || error));

        if (event.type === 'charge.dispute.created' && disputeBk.customer_email) {
          await sendEmail({
            to: disputeBk.customer_email,
            from: 'AssembleAtEase <booking@assembleatease.com>',
            subject: `Dispute Received - ${esc(disputeBk.ref)}`,
            html: buildCustomerDisputeEmail(
              (disputeBk.customer_name || '').split(' ')[0],
              disputeBk.ref,
              liveDispute.reason,
            ),
            replyTo: ownerEmail(),
            meta: { bookingId: disputeBk.id, notificationType: 'stripe_dispute_customer', recipientType: 'customer' },
          }).catch(error => console.error('Customer dispute email error:', error?.message || error));
        }
        webhookMetadata = {
          ...webhookMetadata,
          reason: 'booking-dispute-payout-held',
          disputeId: liveDispute.id,
          disputeStatus: liveStatus,
          payoutHold: true,
        };
        break;
      }

      // ── Easer Membership: subscription activated ──
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (!userId || sub.metadata?.role !== 'assembler_membership') break;
        const active = sub.status === 'active' || sub.status === 'trialing';
        const periodEnd = Number(sub.current_period_end);
        const { error: membershipUpdateError } = await sb.from('profiles').update({
          has_membership: active,
          membership_expires_at: active && Number.isFinite(periodEnd) ? new Date(periodEnd * 1000).toISOString() : null,
          stripe_subscription_id: sub.id,
          membership_tier: active ? 'member' : null,
        }).eq('id', userId).eq('role', 'assembler');
        if (membershipUpdateError) throw membershipUpdateError;

        // Store legacy billing truth even while launch enrollment is disabled,
        // but never promise priority/discount benefits unless explicitly enabled.
        if (active && event.type === 'customer.subscription.created' && isEaserMembershipEnabled()) {
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
        if (!userId || sub.metadata?.role !== 'assembler_membership') break;
        const { error: membershipDeleteError } = await sb.from('profiles').update({
          has_membership: false,
          membership_expires_at: null,
          stripe_subscription_id: null,
          membership_tier: null,
        }).eq('id', userId).eq('role', 'assembler').eq('stripe_subscription_id', sub.id);
        if (membershipDeleteError) throw membershipDeleteError;
        break;
      }

      // ── Easer Membership: invoice paid (renewal) ──
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        if (inv.subscription) {
          const stripe2 = new Stripe(process.env.STRIPE_SECRET_KEY);
          const sub = await stripe2.subscriptions.retrieve(inv.subscription);
          if (sub.metadata?.role !== 'assembler_membership' || !sub.metadata?.userId) break;
          const { data: profiles } = await sb.from('profiles')
            .select('id').eq('id', sub.metadata.userId).eq('role', 'assembler')
            .eq('stripe_subscription_id', inv.subscription).limit(1);
          if (profiles && profiles[0]) {
            const periodEnd = Number(sub.current_period_end);
            const { error: renewalError } = await sb.from('profiles').update({
              has_membership: true,
              membership_expires_at: Number.isFinite(periodEnd) ? new Date(periodEnd * 1000).toISOString() : null,
            }).eq('id', profiles[0].id).eq('role', 'assembler');
            if (renewalError) throw renewalError;
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
    await finalizeStripeWebhookEvent(sb, event.id, {
      bookingId: webhookBookingId,
      paymentIntentId: webhookPaymentIntentId,
      status: webhookOutcome,
      metadata: webhookMetadata,
      error: webhookError,
    });
    return res.status(500).json({ received: false, error: 'Webhook processing failed and is retryable' });
  }

  const finalized = await finalizeStripeWebhookEvent(sb, event.id, {
    bookingId: webhookBookingId,
    paymentIntentId: webhookPaymentIntentId,
    status: webhookOutcome,
    metadata: webhookMetadata,
    error: webhookError,
  });

  if (!finalized?.ok) {
    console.error('Stripe webhook finalization failed:', finalized?.error || 'unknown finalization error');
    return res.status(503).json({ received: false, error: 'Webhook result could not be durably finalized' });
  }

  if (webhookOutcome === 'failed') {
    return res.status(500).json({ received: false, error: webhookError || 'Webhook processing failed and is retryable' });
  }
  return res.status(200).json({ received: true });
}

async function syncEaserApplicationFeeRefund({
  sb,
  stripe,
  event,
  paymentIntentId,
  expectedChargeId = null,
  forceHold = false,
  reason,
}) {
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id, role, status, application_status, full_name, email, is_available, stripe_customer_id, stripe_payment_intent_id, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at')
    .eq('role', 'assembler')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (profileError) throw new Error(`Application-fee refund profile lookup failed: ${profileError.message}`);
  if (!profile) return { handled: false, holdRequired: false, truth: null, result: null };
  if (!profile.stripe_customer_id) {
    throw new Error('Application-fee refund profile is missing its Stripe Customer');
  }

  const observedAt = event?.created
    ? new Date(Number(event.created) * 1000).toISOString()
    : new Date().toISOString();
  const reviewReason = String(reason || 'Stripe application-fee refund activity requires review').slice(0, 1000);
  let holdResult = null;
  if (forceHold) {
    holdResult = await holdEaserApplicationFeeRefund(sb, {
      assemblerId: profile.id,
      paymentIntentId,
      observedAt,
      reason: reviewReason,
    });
  }

  let truth;
  try {
    truth = await loadEaserApplicationFeeRefundTruth({
      stripe,
      assemblerId: profile.id,
      paymentIntentId,
      customerId: profile.stripe_customer_id,
      expectedChargeId,
    });
    if (truth.hasLiveRefundActivity && !forceHold) {
      holdResult = await holdEaserApplicationFeeRefund(sb, {
        assemblerId: profile.id,
        paymentIntentId,
        observedAt,
        reason: reviewReason,
      });
    }
  } catch (error) {
    if (forceHold) {
      await recordEaserApplicationFeeRefundNotice({
        sb,
        event,
        profile,
        reason: reviewReason,
        validationError: error?.message || String(error),
      }).catch(noticeError => console.error('Application-fee refund review notice failed:', noticeError?.message || noticeError));
    }
    throw error;
  }

  const result = await reconcileEaserApplicationFeeRefund(sb, {
    assemblerId: profile.id,
    paymentIntentId,
    customerId: profile.stripe_customer_id,
    truth,
    observedAt,
    reason: reviewReason,
  });
  const holdRequired = truth.hasLiveRefundActivity
    || Boolean(profile.application_fee_refund_review_required_at)
    || Boolean(result.review_required_at);

  if (holdRequired) {
    const { error: offerCancelError } = await sb.from('dispatch_offers')
      .update({ offer_status: 'cancelled' })
      .eq('easer_id', profile.id)
      .eq('offer_status', 'sent');
    if (offerCancelError) {
      throw new Error(`Refund-held Easer offer cancellation failed: ${offerCancelError.message}`);
    }
  }

  if (holdRequired && (
    forceHold
    || holdResult?.result_action === 'held'
    || result.result_action === 'reconciled'
  )) {
    await recordEaserApplicationFeeRefundNotice({
      sb,
      event,
      profile,
      truth,
      reason: reviewReason,
    });
  }

  return { handled: true, holdRequired, truth, result };
}

async function syncEaserApplicationFeeDispute({
  sb,
  stripe,
  event,
  dispute,
  charge,
}) {
  const paymentIntentId = typeof charge?.payment_intent === 'string'
    ? charge.payment_intent
    : charge?.payment_intent?.id || null;
  if (!paymentIntentId) return { handled: false };
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id, role, status, application_status, full_name, email, stripe_customer_id, stripe_payment_intent_id')
    .eq('role', 'assembler')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (profileError) throw new Error(`Application-fee dispute profile lookup failed: ${profileError.message}`);
  if (!profile) return { handled: false };

  const observedAt = event?.created
    ? new Date(Number(event.created) * 1000).toISOString()
    : new Date().toISOString();
  const reason = `Stripe application-fee dispute ${dispute.id || 'unknown'} is ${String(dispute.status || 'unknown')}`;
  await holdEaserApplicationFeeRefund(sb, {
    assemblerId: profile.id,
    paymentIntentId,
    observedAt,
    reason,
  });

  try {
    const paymentTruth = await loadEaserApplicationFeeRefundTruth({
      stripe,
      assemblerId: profile.id,
      paymentIntentId,
      customerId: profile.stripe_customer_id,
      expectedChargeId: charge.id,
    });
    const disputeTruth = await loadEaserApplicationFeeDisputeTruth({
      stripe,
      paymentTruth,
      expectedDisputeId: dispute.id,
    });
    await reconcileEaserApplicationFeeRefund(sb, {
      assemblerId: profile.id,
      paymentIntentId,
      customerId: profile.stripe_customer_id,
      truth: paymentTruth,
      observedAt,
      reason,
    });
    const { error: offerCancelError } = await sb.from('dispatch_offers')
      .update({ offer_status: 'cancelled' })
      .eq('easer_id', profile.id)
      .eq('offer_status', 'sent');
    if (offerCancelError) throw new Error(`Dispute-held Easer offer cancellation failed: ${offerCancelError.message}`);

    const freshDispute = disputeTruth.disputes.find(candidate => candidate.id === dispute.id)
      || disputeTruth.latestDispute;
    await logActivity(sb, {
      bookingId: null,
      eventType: 'easer_application_fee_dispute_hold',
      actorType: 'stripe',
      actorId: profile.id,
      actorName: 'Stripe',
      description: `Stripe application-fee dispute ${freshDispute?.id || dispute.id} placed ${profile.full_name || profile.id} offline for new work; assigned work remains available`,
      metadata: {
        stripeEventId: event?.id || null,
        paymentIntentId,
        chargeId: charge.id,
        disputeId: freshDispute?.id || dispute.id,
        disputeStatus: freshDispute?.status || dispute.status || null,
        disputeAmountCents: Number(freshDispute?.amount || dispute.amount || 0),
        blockingDisputeCount: disputeTruth.blockingDisputes.length,
        newJobsBlocked: true,
        assignedWorkPreserved: true,
      },
    });

    const ownerNotice = await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `URGENT: Easer Application Fee Dispute - ${esc(profile.full_name || profile.id)}`,
      html: `<p>Stripe reports dispute <strong>${esc(freshDispute?.id || dispute.id)}</strong> on the ${EASER_APPLICATION_FEE_DISPLAY} application fee for <strong>${esc(profile.full_name || profile.id)}</strong>.</p><p>Status: <strong>${esc(freshDispute?.status || dispute.status || 'unknown')}</strong>. New offers, assignments, and acceptance are blocked. Existing accepted jobs remain available to finish.</p><p>Review the dispute and PaymentIntent <strong>${esc(paymentIntentId)}</strong> in Stripe. Do not restore availability until the owner reconciliation action proves the dispute is resolved.</p>`,
      meta: {
        notificationType: 'easer_application_fee_dispute_owner',
        recipientType: 'owner',
        recipientUserId: profile.id,
        dedupeWindowMin: 5,
      },
    }).catch(error => ({ ok: false, error: error?.message || String(error) }));
    const easerNotice = profile.email ? await sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: ownerEmail(),
      subject: 'Application Fee Payment Review - AssembleAtEase',
      html: '<p>Stripe reported a payment dispute related to your application fee. Your account is offline for new job offers while AssembleAtEase reviews it.</p><p>Any job you already accepted remains available to complete. Reply to this email if you need help.</p>',
      meta: {
        notificationType: 'easer_application_fee_dispute_easer',
        recipientType: 'easer',
        recipientUserId: profile.id,
        dedupeWindowMin: 5,
      },
    }).catch(error => ({ ok: false, error: error?.message || String(error) })) : null;
    if (ownerNotice?.ok !== true || (profile.email && easerNotice?.ok !== true)) {
      await logActivity(sb, {
        bookingId: null,
        eventType: 'easer_application_fee_dispute_notification_failed',
        actorType: 'system',
        actorId: profile.id,
        actorName: 'notifications',
        description: 'Application-fee dispute hold was saved, but one or more notification emails failed',
        metadata: {
          stripeEventId: event?.id || null,
          ownerEmailError: ownerNotice?.ok === true ? null : ownerNotice?.error || 'unknown',
          easerEmailError: !profile.email || easerNotice?.ok === true ? null : easerNotice?.error || 'unknown',
        },
      }).catch(() => {});
    }
    return { handled: true, paymentTruth, disputeTruth, profile };
  } catch (error) {
    await recordEaserApplicationFeeRefundNotice({
      sb,
      event,
      profile,
      reason,
      validationError: error?.message || String(error),
    }).catch(() => {});
    throw error;
  }
}

async function recordEaserApplicationFeeRefundNotice({
  sb,
  event,
  profile,
  truth = null,
  reason,
  validationError = null,
}) {
  const refundedCents = Number(truth?.succeededRefundedCents || 0);
  const pendingCents = Number(truth?.pendingRefundCents || 0);
  const remainingCents = Math.max(0, EASER_APPLICATION_FEE_CENTS - refundedCents);
  const amount = cents => `$${(Number(cents || 0) / 100).toFixed(2)}`;
  const eventType = validationError
    ? 'easer_application_fee_refund_review_required'
    : 'easer_application_fee_refund_synchronized';
  const description = validationError
    ? `Stripe application-fee refund activity for ${profile.full_name || profile.id} could not be fully validated; new jobs remain blocked for owner review`
    : `Stripe application-fee refund truth synchronized for ${profile.full_name || profile.id}: ${amount(refundedCents)} succeeded, ${amount(pendingCents)} pending; new jobs blocked`;

  await logActivity(sb, {
    bookingId: null,
    eventType,
    actorType: 'stripe',
    actorId: profile.id,
    actorName: 'Stripe',
    description,
    metadata: {
      stripeEventId: event?.id || null,
      paymentIntentId: profile.stripe_payment_intent_id,
      reason,
      validationError,
      applicationFeeCents: EASER_APPLICATION_FEE_CENTS,
      refundedCents,
      pendingRefundCents: pendingCents,
      remainingCents,
      fullyRefunded: truth?.fullyRefunded === true,
      newJobsBlocked: true,
      assignedWorkPreserved: true,
    },
  });

  const ownerNotice = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Owner Action Required - Easer Application Fee Refund - ${esc(profile.full_name || profile.id)}`,
    html: validationError
      ? `<p>Stripe reported application-fee refund activity for <strong>${esc(profile.full_name || profile.id)}</strong>, but the complete Stripe payment/refund truth could not be validated.</p><p>The Easer is offline for all new offers and assignments. Existing accepted work remains available to complete. Review PaymentIntent <strong>${esc(profile.stripe_payment_intent_id)}</strong> in Stripe before changing availability.</p><p>Validation error: ${esc(validationError)}</p>`
      : `<p>Stripe application-fee refund truth changed for <strong>${esc(profile.full_name || profile.id)}</strong>.</p><p>Succeeded refunds: <strong>${amount(refundedCents)}</strong><br/>Pending refunds: <strong>${amount(pendingCents)}</strong><br/>Unrefunded fee amount: <strong>${amount(remainingCents)}</strong></p><p>New offers, assignments, and acceptance are blocked. Existing accepted jobs remain available to finish. Review the Easer and PaymentIntent <strong>${esc(profile.stripe_payment_intent_id)}</strong>.</p>`,
    meta: {
      notificationType: 'easer_application_fee_refund_owner',
      recipientType: 'owner',
      recipientUserId: profile.id,
      dedupeWindowMin: 5,
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  const easerNotice = profile.email ? await sendEmail({
    to: profile.email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    replyTo: ownerEmail(),
    subject: 'Application Fee Refund Review - AssembleAtEase',
    html: validationError
      ? `<p>Stripe reported refund activity on your ${EASER_APPLICATION_FEE_DISPLAY} application fee. Your account is temporarily offline for new job offers while AssembleAtEase reviews the payment.</p><p>Any job you already accepted remains available to complete. Reply to this email if you need help.</p>`
      : `<p>Stripe now reports ${amount(refundedCents)} in completed refunds and ${amount(pendingCents)} pending on your ${EASER_APPLICATION_FEE_DISPLAY} application fee.</p><p>Your account is offline for new job offers while AssembleAtEase reviews this change. Any job you already accepted remains available to complete. Reply to this email if you need help.</p>`,
    meta: {
      notificationType: 'easer_application_fee_refund_easer',
      recipientType: 'easer',
      recipientUserId: profile.id,
      dedupeWindowMin: 5,
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) })) : null;

  if (ownerNotice?.ok !== true || (profile.email && easerNotice?.ok !== true)) {
    await logActivity(sb, {
      bookingId: null,
      eventType: 'easer_application_fee_refund_notification_failed',
      actorType: 'system',
      actorId: profile.id,
      actorName: 'notifications',
      description: 'Application-fee refund truth was saved, but one or more notification emails failed',
      metadata: {
        stripeEventId: event?.id || null,
        ownerEmailError: ownerNotice?.ok === true ? null : ownerNotice?.error || 'unknown',
        easerEmailError: !profile.email || easerNotice?.ok === true ? null : easerNotice?.error || 'unknown',
      },
    }).catch(() => {});
  }
}

async function syncAuthorizedCustomerQuote({ sb, stripe, pi, event }) {
  const eventBookingId = pi.metadata?.bookingId || null;
  if (!eventBookingId) return { bookingId: null, outcome: 'ignored', error: null, metadata: { reason: 'quote-booking-id-missing' } };

  const liveAuthorization = await stripe.paymentIntents.retrieve(pi.id);
  if (liveAuthorization.id !== pi.id || liveAuthorization.metadata?.bookingId !== eventBookingId) {
    return {
      bookingId: eventBookingId,
      outcome: 'failed',
      error: 'Quote authorization no longer matches the event booking',
      metadata: { reason: 'quote-authorization-live-link-mismatch' },
    };
  }
  pi = liveAuthorization;
  const bookingId = pi.metadata?.bookingId || null;
  if (!bookingId) return { bookingId: null, outcome: 'ignored', error: null, metadata: { reason: 'quote-booking-id-missing' } };

  const { data: booking, error: bookingError } = await sb.from('bookings')
    .select('id, ref, service, status, payment_status, total_price, quote_amount_cents, quote_tax_cents, quote_terms_version, quote_expires_at, quote_approval_started_at, quote_approved_at, quote_token_hash, stripe_payment_intent_id, assembler_id, customer_name, customer_email, financial_operation_key, financial_operation_type')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingError) throw new Error(`Quote authorization lookup failed: ${bookingError.message}`);
  if (!booking) return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'quote-booking-not-found' } };
  if (booking.financial_operation_key) {
    return {
      bookingId,
      outcome: 'ignored',
      error: null,
      metadata: { reason: 'financial-operation-will-reconcile-quote', financialOperationType: booking.financial_operation_type || null },
    };
  }

  if (['captured', 'cancellation_fee_captured', 'partially_refunded', 'refunded'].includes(booking.payment_status)) {
    return {
      bookingId,
      outcome: 'ignored',
      error: null,
      metadata: { reason: 'stale-quote-authorization-after-financial-finalization', currentPaymentStatus: booking.payment_status },
    };
  }
  if (pi.status !== 'requires_capture') {
    return {
      bookingId,
      outcome: 'ignored',
      error: null,
      metadata: { reason: 'stale-quote-authorization-status', stripeStatus: pi.status || null },
    };
  }

  const validation = validateBookingPaymentIntent(booking, pi, {
    type: 'customer_quote',
    amountCents: booking.quote_amount_cents,
  });
  if (pi.metadata?.quoteTermsVersion !== booking.quote_terms_version) {
    validation.errors.push('quote_terms_version');
    validation.ok = false;
  }
  if (!validation.ok) {
    return {
      bookingId,
      outcome: 'failed',
      error: `Quote authorization did not match booking truth: ${validation.errors.join(', ') || pi.status || 'unknown status'}`,
      metadata: { reason: 'quote-authorization-validation-failed', validationErrors: validation.errors, stripeStatus: pi.status || null },
    };
  }

  if (booking.status === 'confirmed' && booking.payment_status === 'authorized' && booking.quote_approved_at) {
    let dispatchResult = null;
    if (!booking.assembler_id) dispatchResult = await dispatchBooking(booking.id);
    return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'quote-already-authorized', dispatchResult } };
  }

  const approvalStartedAt = Date.parse(booking.quote_approval_started_at || '');
  const expiresAt = Date.parse(booking.quote_expires_at || '');
  const approvalWasTimely = Number.isFinite(approvalStartedAt)
    && Number.isFinite(expiresAt)
    && approvalStartedAt <= expiresAt;
  const stateIsFinalizable = booking.status === 'pending'
    && booking.payment_status === 'quote_authorization_pending'
    && !!booking.quote_token_hash
    && approvalWasTimely;

  if (!stateIsFinalizable) {
    let released = false;
    try {
      const canceled = await stripe.paymentIntents.cancel(pi.id, {}, {
        idempotencyKey: `quote-webhook-release-${booking.id}-${pi.id}`,
      });
      released = canceled?.status === 'canceled';
    } catch (cancelError) {
      console.error('[stripe-webhook] Conflicting quote authorization release failed:', cancelError?.message || cancelError);
    }
    if (released && booking.status === 'pending') {
      await sb.from('bookings').update({
        stripe_payment_intent_id: null,
        payment_status: 'quote_pending_approval',
        quote_approval_started_at: null,
      })
        .eq('id', booking.id)
        .eq('stripe_payment_intent_id', pi.id)
        .eq('status', 'pending')
        .is('financial_operation_key', null);
    }
    return released
      ? { bookingId, outcome: 'processed', error: null, metadata: { reason: 'conflicting-quote-authorization-released' } }
      : { bookingId, outcome: 'failed', error: 'Quote is authorized in Stripe but its booking state is not safely finalizable', metadata: { reason: 'quote-state-conflict' } };
  }

  const confirmedAt = event.created ? new Date(event.created * 1000).toISOString() : new Date().toISOString();
  const { data: confirmedRows, error: confirmError } = await sb.from('bookings').update({
    total_price: booking.quote_amount_cents,
    tax_amount: booking.quote_tax_cents,
    payment_status: 'authorized',
    payment_authorized_at: confirmedAt,
    status: 'confirmed',
    confirmed_at: confirmedAt,
    confirmed_by: 'stripe_quote_webhook',
    quote_approved_at: confirmedAt,
    quote_token_hash: null,
  })
    .eq('id', booking.id)
    .eq('status', 'pending')
    .eq('payment_status', 'quote_authorization_pending')
    .eq('stripe_payment_intent_id', pi.id)
    .eq('quote_amount_cents', booking.quote_amount_cents)
    .is('financial_operation_key', null)
    .select('id');
  if (confirmError || !confirmedRows?.length) {
    const { data: current } = await sb.from('bookings')
      .select('status, payment_status, stripe_payment_intent_id, assembler_id')
      .eq('id', booking.id)
      .maybeSingle();
    if (current?.status === 'confirmed'
        && current?.payment_status === 'authorized'
        && current?.stripe_payment_intent_id === pi.id) {
      const dispatchResult = current.assembler_id ? null : await dispatchBooking(booking.id);
      return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'quote-concurrently-finalized', dispatchResult } };
    }
    return { bookingId, outcome: 'failed', error: confirmError?.message || 'Quote authorization could not be persisted', metadata: { reason: 'quote-confirmation-persist-failed' } };
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'quote_authorized',
    actorType: 'stripe',
    actorName: 'Stripe',
    description: `${booking.ref} quote authorization was reconciled and the booking was confirmed`,
    metadata: { stripeEventId: event.id, paymentIntentId: pi.id, amountCents: booking.quote_amount_cents },
  });

  const dispatchResult = await dispatchBooking(booking.id);
  const amountDisplay = `$${(Number(booking.quote_amount_cents || 0) / 100).toFixed(2)}`;
  await Promise.allSettled([
    sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Quote approved and booking confirmed - ${booking.ref}`,
      html: `<p>Your quote for <strong>${esc(booking.service)}</strong> was approved for <strong>${amountDisplay}</strong>.</p><p>Your card is authorized, not charged. Payment is captured only after completed work, except for disclosed cancellation fees.</p>`,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'customer' },
    }),
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer approved quote - ${booking.ref} - ${amountDisplay}`,
      html: `<p><strong>${esc(booking.customer_name)}</strong> approved quote <strong>${esc(booking.ref)}</strong> for ${amountDisplay}. Stripe authorization ${esc(pi.id)} is ready for capture after completion.</p>`,
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'owner' },
    }),
  ]);

  return { bookingId, outcome: 'processed', error: null, metadata: { reason: 'quote-authorized', dispatchResult } };
}

async function syncCapturedCustomerPayment({ sb, stripe, pi, event }) {
  const bookingId = pi.metadata?.bookingId;
  if (!bookingId) return { bookingId: null, outcome: 'ignored', error: null, metadata: { reason: 'missing-booking-id' } };

  const { data: current, error: fetchErr } = await sb.from('bookings')
    .select('id, payment_status, status, amount_charged, total_price, deposit_amount, stripe_customer_id, stripe_deposit_intent_id, stripe_payment_intent_id, stripe_balance_payment_intent_id, financial_operation_key, financial_operation_type, customer_name, customer_email, ref, service, date')
    .eq('id', bookingId)
    .maybeSingle();
  if (fetchErr) throw new Error(`Captured payment lookup failed: ${fetchErr.message}`);
  if (!current) return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'booking-not-found', bookingId } };

  const refundProtectedStatuses = ['refund_pending', 'partially_refunded', 'refunded'];
  if (refundProtectedStatuses.includes(current.payment_status)) {
    return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'stale-capture-after-refund', bookingId } };
  }
  if (current.financial_operation_key) {
    return {
      bookingId,
      outcome: 'ignored',
      error: null,
      metadata: {
        reason: 'reserved-financial-operation-will-finalize',
        bookingId,
        financialOperationType: current.financial_operation_type,
      },
    };
  }

  const capturedAt = event.created
    ? new Date(event.created * 1000).toISOString()
    : new Date().toISOString();

  if (pi.metadata?.type === 'customer_booking_balance') {
    const depositCents = Number(current.deposit_amount || 0);
    const totalCents = Number(current.total_price || 0);
    const expectedBalanceCents = totalCents - depositCents;
    const depositIntentId = current.stripe_deposit_intent_id || current.stripe_payment_intent_id;
    if ((current.stripe_balance_payment_intent_id && current.stripe_balance_payment_intent_id !== pi.id)
        || !depositIntentId
        || depositCents <= 0
        || expectedBalanceCents <= 0
        || !Number.isInteger(totalCents)
        || !Number.isInteger(depositCents)) {
      throw new Error('Balance PaymentIntent does not match the booking deposit split.');
    }

    const depositIntent = await stripe.paymentIntents.retrieve(depositIntentId, { expand: ['latest_charge.balance_transaction'] });
    const validDeposit = depositIntent.status === 'succeeded'
      && depositIntent.currency === 'usd'
      && Number(depositIntent.amount_received || 0) === depositCents
      && depositIntent.metadata?.bookingId === bookingId
      && (!current.stripe_customer_id || depositIntent.customer === current.stripe_customer_id)
      && ['customer_booking', 'customer_quote', 'customer_booking_deposit'].includes(depositIntent.metadata?.type);
    if (!validDeposit) throw new Error('Deposit PaymentIntent does not match the booking deposit split.');

    const balanceIntent = await stripe.paymentIntents.retrieve(pi.id, { expand: ['latest_charge.balance_transaction'] });
    const validBalance = balanceIntent.id === pi.id
      && balanceIntent.status === 'succeeded'
      && balanceIntent.currency === 'usd'
      && Number(balanceIntent.amount || 0) === expectedBalanceCents
      && Number(balanceIntent.amount_received || 0) === expectedBalanceCents
      && balanceIntent.metadata?.bookingId === bookingId
      && balanceIntent.metadata?.type === 'customer_booking_balance'
      && (!current.stripe_customer_id || balanceIntent.customer === current.stripe_customer_id);
    if (!validBalance) throw new Error('Balance PaymentIntent does not match the booking deposit split.');

    const depositRefundedCents = Number(depositIntent.latest_charge?.amount_refunded || 0);
    const balanceRefundedCents = Number(balanceIntent.latest_charge?.amount_refunded || 0);
    if (depositRefundedCents > 0 || balanceRefundedCents > 0) {
      return {
        bookingId,
        outcome: 'ignored',
        error: null,
        metadata: {
          reason: 'stale-balance-capture-after-stripe-refund',
          bookingId,
          depositRefundedCents,
          balanceRefundedCents,
        },
      };
    }

    const depositFee = depositIntent.latest_charge?.balance_transaction?.fee;
    const balanceFee = balanceIntent.latest_charge?.balance_transaction?.fee;
    const combinedStripeFee = typeof depositFee === 'number' && typeof balanceFee === 'number'
      ? depositFee + balanceFee
      : null;
    const combinedAmount = depositCents + Number(pi.amount_received || 0);

    if (current.payment_status === 'captured'
        && Number(current.amount_charged || 0) === combinedAmount
        && current.stripe_balance_payment_intent_id === pi.id) {
      return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'already-captured-deposit-balance', bookingId } };
    }

    const balanceUpdates = {
      payment_status: 'captured',
      amount_charged: combinedAmount,
      payment_captured_at: capturedAt,
      stripe_balance_payment_intent_id: pi.id,
      stripe_balance_amount_captured: Number(pi.amount_received || 0),
    };
    if (combinedStripeFee != null) balanceUpdates.stripe_fee = combinedStripeFee;
    let balanceUpdateQuery = sb.from('bookings')
      .update(balanceUpdates)
      .eq('id', bookingId)
      .eq('payment_status', current.payment_status)
      .eq('total_price', totalCents)
      .eq('deposit_amount', depositCents)
      .is('financial_operation_key', null)
      .not('payment_status', 'in', '(refund_pending,partially_refunded,refunded)');
    balanceUpdateQuery = current.stripe_payment_intent_id == null
      ? balanceUpdateQuery.is('stripe_payment_intent_id', null)
      : balanceUpdateQuery.eq('stripe_payment_intent_id', current.stripe_payment_intent_id);
    balanceUpdateQuery = current.stripe_deposit_intent_id == null
      ? balanceUpdateQuery.is('stripe_deposit_intent_id', null)
      : balanceUpdateQuery.eq('stripe_deposit_intent_id', current.stripe_deposit_intent_id);
    balanceUpdateQuery = current.stripe_balance_payment_intent_id
      ? balanceUpdateQuery.eq('stripe_balance_payment_intent_id', pi.id)
      : balanceUpdateQuery.is('stripe_balance_payment_intent_id', null);
    const { error: balanceUpdateError, data: balanceRows } = await balanceUpdateQuery.select('id');
    if (balanceUpdateError) throw new Error(`Balance payment sync failed: ${balanceUpdateError.message}`);
    if (!balanceRows?.length) {
      return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'balance-capture-state-changed', bookingId } };
    }

    await logActivity(sb, {
      bookingId,
      eventType: 'balance_captured_recovery',
      actorType: 'system',
      actorName: 'stripe_webhook',
      description: `Stripe recovered deposit plus balance payment truth: $${(combinedAmount / 100).toFixed(2)}`,
      metadata: { stripeEventId: event.id, depositIntentId, balanceIntentId: pi.id, amountCharged: combinedAmount },
    });

    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Owner review: balance captured before completion finalized - ${esc(current.ref)}`,
      html: `<p>Stripe captured the remaining balance for booking <strong>${esc(current.ref)}</strong>. Combined deposit and balance: <strong>$${(combinedAmount / 100).toFixed(2)}</strong>.</p><p>The booking still needs completion reconciliation. Do not charge the customer again.</p>`,
      meta: { bookingId, notificationType: 'balance_capture_recovery_owner', recipientType: 'owner', disableDedupe: true },
    }).catch(() => ({ ok: false }));

    return {
      bookingId,
      outcome: 'processed',
      error: null,
      metadata: { amountCharged: combinedAmount, captureType: 'deposit_plus_balance_recovery' },
    };
  }

  if (current.stripe_payment_intent_id !== pi.id) {
    return {
      bookingId,
      outcome: 'ignored',
      error: null,
      metadata: { reason: 'stale-capture-payment-intent', bookingId, currentPaymentIntentId: current.stripe_payment_intent_id },
    };
  }

  const capturedIntent = await stripe.paymentIntents.retrieve(pi.id, { expand: ['latest_charge.balance_transaction'] });
  const allowedPrimaryType = ['customer_booking', 'customer_quote'].includes(capturedIntent.metadata?.type)
    || (capturedIntent.metadata?.type === 'reauth' && capturedIntent.id === current.stripe_payment_intent_id);
  const totalCents = Number(current.total_price || 0);
  const capturedCents = Number(capturedIntent.amount_received || 0);
  const validPrimaryCapture = capturedIntent.status === 'succeeded'
    && capturedIntent.capture_method === 'manual'
    && capturedIntent.currency === 'usd'
    && Number.isInteger(totalCents)
    && totalCents > 0
    && Number(capturedIntent.amount || 0) === totalCents
    && Number.isInteger(capturedCents)
    && capturedCents > 0
    && capturedCents <= totalCents
    && capturedIntent.metadata?.bookingId === bookingId
    && (!current.stripe_customer_id || capturedIntent.customer === current.stripe_customer_id)
    && allowedPrimaryType;
  if (!validPrimaryCapture) {
    throw new Error('Captured PaymentIntent does not match current booking truth.');
  }

  const stripeRefundedCents = Number(capturedIntent.latest_charge?.amount_refunded || 0);
  if (stripeRefundedCents > 0) {
    return {
      bookingId,
      outcome: 'ignored',
      error: null,
      metadata: { reason: 'stale-capture-after-stripe-refund', bookingId, stripeRefundedCents },
    };
  }

  if (current.payment_status === 'captured' && Number(current.amount_charged || 0) === capturedCents) {
    return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'already-captured', bookingId } };
  }
  if (Number(current.amount_charged || 0) > capturedCents) {
    return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'stale-lower-capture-amount', bookingId } };
  }

  const isPartialCapture = capturedCents < Number(capturedIntent.amount || 0);
  const { error: updateErr, data: captureRows } = await sb.from('bookings').update({
    payment_status: (current.status === 'cancelled' || isPartialCapture) ? 'cancellation_fee_captured' : 'captured',
    amount_charged: capturedCents,
    payment_captured_at: capturedAt,
  })
    .eq('id', bookingId)
    .eq('payment_status', current.payment_status)
    .eq('stripe_payment_intent_id', pi.id)
    .eq('total_price', totalCents)
    .not('payment_status', 'in', '(refund_pending,partially_refunded,refunded)')
    .is('financial_operation_key', null)
    .select('id');
  if (updateErr) throw new Error(`Captured payment sync failed: ${updateErr.message}`);
  if (!captureRows?.length) {
    return { bookingId, outcome: 'ignored', error: null, metadata: { reason: 'financial-operation-reserved-during-webhook', bookingId } };
  }

  await logActivity(sb, {
    bookingId,
    eventType: 'captured',
    actorType: 'system',
    actorName: 'stripe_webhook',
    description: `Stripe webhook captured payment: $${(capturedCents / 100).toFixed(2)}`,
    metadata: { stripeEventId: event.id, paymentIntentId: pi.id, amountCharged: capturedCents },
  });

  if (isPartialCapture) {
    return {
      bookingId,
      outcome: 'processed',
      error: null,
      metadata: { amountCharged: capturedCents, captureType: 'cancellation_fee' },
    };
  }

  const amountDisplay = `$${(capturedCents / 100).toFixed(2)}`;
  await Promise.allSettled([
    sendEmail({
      to: current.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Payment Receipt — ${esc(current.ref)}`,
      html: buildCustomerReceiptEmail(current, amountDisplay),
      replyTo: ownerEmail(),
      meta: { bookingId, notificationType: 'payment_receipt', recipientType: 'customer' },
    }),
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Payment Captured — ${esc(current.ref)} — ${amountDisplay || ''}`,
      html: buildOwnerCaptureEmail(current, amountDisplay),
      meta: { bookingId, notificationType: 'payment_captured_owner', recipientType: 'owner' },
    }),
  ]);

  return { bookingId, outcome: 'processed', error: null, metadata: { amountCharged: capturedCents } };
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
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#dc2626">Chargeback Dispute Opened</p>
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
    ? `${esc(fullName)} - Identity Verified`
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
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Use the time-limited AssembleAtEase link below to retry. If another attempt is required, use the newest link sent to you.</p>
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
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">We were unable to process your ${EASER_APPLICATION_FEE_DISPLAY} application fee. Reason: <strong>${esc(reason)}</strong></p>
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
