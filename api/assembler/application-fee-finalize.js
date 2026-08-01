import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { getClientIp } from '../_assembler-onboarding.js';
import { isEaserClosureBlocking } from '../_easer-closure.js';
import {
  hasEaserApplicationFeeRefundHold,
  validateEaserApplicationPaymentIntent,
  verifyApplicationFeeContinuationToken,
} from '../_easer-application-fee.js';
import {
  loadEaserApplicationFeeRefundTruth,
  reconcileEaserApplicationFeeRefund,
} from '../_easer-application-refund.js';
import { finalizeEaserApplicationSubmission } from './apply.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  if (!await rateLimit(getClientIp(req), 'apply')) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  let continuation;
  try {
    continuation = verifyApplicationFeeContinuationToken(req.body?.feeContinuationToken);
  } catch (tokenError) {
    return res.status(401).json({
      error: 'This payment continuation expired or is invalid. Retry the same application to recover it safely.',
      code: 'APPLICATION_FEE_CONTINUATION_INVALID',
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Application fee verification is temporarily unavailable.' });
  }

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, role, status, application_status, application_fee_paid, payment_confirmed, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, stripe_customer_id, stripe_payment_intent_id, account_closure_status')
    .eq('id', continuation.profileId)
    .maybeSingle();
  if (profileError) {
    console.error('Application fee finalization profile lookup failed:', profileError);
    return res.status(503).json({ error: 'Application fee state could not be verified. Please try again.' });
  }
  if (!profile
      || profile.role !== 'assembler'
      || !profile.stripe_customer_id
      || profile.stripe_payment_intent_id !== continuation.paymentIntentId) {
    return res.status(404).json({ error: 'Application payment continuation was not found.' });
  }
  if (String(profile.status || '').trim().toLowerCase() !== 'pending'
      || isEaserClosureBlocking(profile)) {
    return res.status(409).json({
      error: 'This application is no longer accepting payment. No additional payment was attempted.',
      code: 'APPLICATION_FEE_FINALIZATION_CLOSED',
    });
  }
  if (!['payment_pending', 'applied'].includes(String(profile.application_status || '').toLowerCase())) {
    return res.status(409).json({
      error: 'This application is no longer accepting payment. Contact support if your card was charged.',
      code: 'APPLICATION_FEE_FINALIZATION_CLOSED',
    });
  }
  if (profile.application_fee_waived === true || profile.fee_waived_by_owner === true) {
    return res.status(409).json({
      error: 'Your application payment status changed. No additional payment was attempted. Refresh your application status or contact support.',
      code: 'APPLICATION_FEE_TRUTH_MISMATCH',
    });
  }
  if (hasEaserApplicationFeeRefundHold(profile)) {
    return res.status(409).json({
      error: 'This application payment is temporarily on hold. No additional payment will be attempted. Contact support.',
      code: 'APPLICATION_FEE_REFUND_REVIEW_REQUIRED',
    });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const paymentIntent = await stripe.paymentIntents.retrieve(continuation.paymentIntentId);
    validateEaserApplicationPaymentIntent(paymentIntent, {
      userId: continuation.profileId,
      paymentIntentId: continuation.paymentIntentId,
      customerId: profile.stripe_customer_id,
    });
    if (paymentIntent.status !== 'succeeded') {
      return res.status(409).json({
        error: 'The application fee is not complete yet. Complete any card verification shown and retry.',
        code: 'APPLICATION_FEE_NOT_COMPLETE',
      });
    }
    validateEaserApplicationPaymentIntent(paymentIntent, {
      userId: continuation.profileId,
      paymentIntentId: continuation.paymentIntentId,
      customerId: profile.stripe_customer_id,
      requireSucceeded: true,
      requireConsent: true,
    });
    const refundTruth = await loadEaserApplicationFeeRefundTruth({
      stripe,
      assemblerId: continuation.profileId,
      paymentIntentId: continuation.paymentIntentId,
      customerId: profile.stripe_customer_id,
    });
    if (refundTruth.hasLiveRefundActivity) {
      await reconcileEaserApplicationFeeRefund(sb, {
        assemblerId: continuation.profileId,
        paymentIntentId: continuation.paymentIntentId,
        customerId: profile.stripe_customer_id,
        truth: refundTruth,
        reason: 'Browser finalization observed application-fee refund activity',
      });
      return res.status(409).json({
        error: 'This application payment is temporarily on hold. No additional payment will be attempted. Contact support.',
        code: 'APPLICATION_FEE_REFUND_REVIEW_REQUIRED',
      });
    }

    const stripeCustomerId = typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : paymentIntent.customer?.id || null;
    const { data: paidProfile, error: paidPersistError } = await sb.from('profiles')
      .update({
        stripe_customer_id: stripeCustomerId,
        payment_confirmed: true,
        application_fee_paid: true,
      })
      .eq('id', continuation.profileId)
      .eq('stripe_payment_intent_id', continuation.paymentIntentId)
      .eq('stripe_customer_id', profile.stripe_customer_id)
      .eq('status', 'pending')
      .eq('application_fee_waived', false)
      .eq('fee_waived_by_owner', false)
      .eq('application_fee_refunded', false)
      .eq('application_fee_refunded_cents', 0)
      .eq('application_fee_refund_pending_cents', 0)
      .is('application_fee_refund_review_required_at', null)
      .or('account_closure_status.is.null,account_closure_status.eq.cancelled')
      .select('id')
      .maybeSingle();
    if (paidPersistError || !paidProfile) {
      throw new Error(`Application fee truth persistence failed: ${paidPersistError?.message || 'profile changed'}`);
    }

    const finalized = await finalizeEaserApplicationSubmission({
      sb,
      userId: continuation.profileId,
      expectedPaymentIntentId: continuation.paymentIntentId,
      stripeClient: stripe,
    });
    return res.status(200).json(finalized);
  } catch (error) {
    if (/account closure|account.*closed|closure status/i.test(String(error?.message || error))) {
      return res.status(409).json({
        error: 'This application closed before payment finished. Contact support before taking another payment action.',
        code: 'APPLICATION_FEE_FINALIZATION_CLOSED',
      });
    }
    console.error('Application fee finalization failed:', error?.message || error);
    return res.status(503).json({
      error: 'Your payment was not added to the application. Retry the same application; you will not be charged again.',
      code: 'APPLICATION_FEE_FINALIZATION_RETRYABLE',
    });
  }
}
