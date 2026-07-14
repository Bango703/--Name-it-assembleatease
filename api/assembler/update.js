import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { randomUUID } from 'crypto';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import {
  ACTIVE_EASER_TIERS,
  getPreservedTier,
  getRestorableTier,
  normalizeAssemblerProfile,
} from '../_assembler-state.js';
import { getEaserReadiness, readinessError } from '../_easer-readiness.js';
import {
  EASER_APPLICATION_FEE_CENTS,
  validateEaserApplicationPaymentIntent,
} from '../_easer-application-fee.js';
import {
  loadEaserApplicationFeeDisputeTruth,
  loadEaserApplicationFeeRefundTruth,
  reconcileEaserApplicationFeeRefund,
} from '../_easer-application-refund.js';
import { isEaserClosureBlocking, normalizeEaserClosureStatus } from '../_easer-closure.js';
import { loadLedgerFirstFinanceRows } from '../owner/_finance-ledger.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../_assembler-onboarding.js';
import { logActivity } from '../booking/_activity.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

function applicationDecisionSnapshot(profile = {}) {
  return {
    status: profile.status ?? null,
    application_status: profile.application_status ?? null,
    tier: profile.tier ?? null,
    is_available: profile.is_available === true,
    identity_verified: profile.identity_verified === true,
    contractor_agreement_signed: Boolean(profile.contractor_agreement_signed_at),
    contractor_agreement_version: profile.contractor_agreement_version ?? null,
    code_of_conduct_accepted: Boolean(profile.code_of_conduct_agreed_at),
    phone: String(profile.phone || '').trim(),
    application_fee_paid: profile.application_fee_paid === true,
    payment_confirmed: profile.payment_confirmed === true,
    application_fee_waived: profile.application_fee_waived === true,
    fee_waived_by_owner: profile.fee_waived_by_owner === true,
    application_fee_refunded: profile.application_fee_refunded === true,
    application_fee_refunded_cents: Number(profile.application_fee_refunded_cents || 0),
    application_fee_refund_pending_cents: Number(profile.application_fee_refund_pending_cents || 0),
    application_fee_refund_review_required_at_present: Boolean(profile.application_fee_refund_review_required_at),
    application_fee_refund_review_reason: profile.application_fee_refund_review_reason ?? null,
    application_fee_refund_id: profile.application_fee_refund_id ?? null,
    application_fee_refunded_at_present: Boolean(profile.application_fee_refunded_at),
    stripe_payment_intent_id: profile.stripe_payment_intent_id ?? null,
    stripe_customer_id: profile.stripe_customer_id ?? null,
    account_closure_status: profile.account_closure_status ?? null,
    approved_at_present: Boolean(profile.approved_at),
  };
}

function applicationDecisionKey(assemblerId, decision) {
  return `easer-application:${decision}:${assemblerId}:${randomUUID()}`;
}

async function claimApplicationDecision(sb, {
  assemblerId,
  decision,
  operationKey,
  expectedProfile,
}) {
  const { data, error } = await sb.rpc('claim_easer_application_decision', {
    p_assembler_id: assemblerId,
    p_decision: decision,
    p_operation_key: operationKey,
    p_expected_snapshot: applicationDecisionSnapshot(expectedProfile),
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.result_action) throw new Error('Application decision claim returned no authoritative result');
  return result;
}

async function releaseApplicationDecision(sb, { assemblerId, decision, operationKey }) {
  const { data, error } = await sb.rpc('release_easer_application_decision', {
    p_assembler_id: assemblerId,
    p_decision: decision,
    p_operation_key: operationKey,
  });
  if (error) throw error;
  return data === true;
}

async function finalizeApplicationDecision(sb, {
  assemblerId,
  decision,
  operationKey,
  expectedProfile,
  refundId = null,
  refundedAt = null,
  rejectionReason = null,
}) {
  const { data, error } = await sb.rpc('finalize_easer_application_decision', {
    p_assembler_id: assemblerId,
    p_decision: decision,
    p_operation_key: operationKey,
    p_expected_snapshot: applicationDecisionSnapshot(expectedProfile),
    p_required_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
    p_refund_id: refundId,
    p_refunded_at: refundedAt,
    p_rejection_reason: rejectionReason,
    p_decided_at: new Date().toISOString(),
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.result_action) throw new Error('Application decision finalization returned no authoritative result');
  return result;
}

async function loadRawEaserProfile(sb, assemblerId) {
  const { data, error } = await sb.from('profiles')
    .select('*')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || 'Easer profile not found');
  return data;
}

function applicationDecisionHttpError(error, fallback) {
  const message = error?.message || String(error || fallback);
  const conflict = error?.code === '55P03'
    || error?.code === '40001'
    || error?.code === '23514'
    || /decision|profile state changed|closure|active Easer|already in progress/i.test(message);
  return {
    status: conflict ? 409 : 503,
    code: conflict ? 'APPLICATION_DECISION_CONFLICT' : 'APPLICATION_DECISION_DATABASE_REQUIRED',
    error: conflict
      ? 'Another application decision or profile update is already in progress. Refresh before trying again.'
      : fallback,
  };
}

async function verifyApprovalStripeTruth(profile, assemblerId) {
  const feePaid = profile.application_fee_paid === true;
  const feeWaived = profile.application_fee_waived === true || profile.fee_waived_by_owner === true;
  if (feePaid === feeWaived) {
    throw new Error('Application fee truth must be exactly one of paid or waived');
  }
  if (feeWaived && profile.payment_confirmed === true) {
    throw new Error('A waived application cannot also report a confirmed payment');
  }
  if (profile.application_fee_refunded === true
      || Number(profile.application_fee_refunded_cents || 0) > 0
      || Number(profile.application_fee_refund_pending_cents || 0) > 0
      || profile.application_fee_refund_review_required_at
      || profile.application_fee_refund_id
      || profile.application_fee_refunded_at) {
    throw new Error('A refunded application cannot be approved');
  }

  if (!profile.stripe_payment_intent_id) {
    if (!feeWaived) throw new Error('A paid application is missing its Stripe PaymentIntent');
    return { feeMode: 'waived', paymentIntentId: null };
  }
  if (!process.env.STRIPE_SECRET_KEY || !profile.stripe_customer_id) {
    const error = new Error('Stripe application payment verification is unavailable');
    error.status = 503;
    throw error;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let paymentIntent;
  if (feePaid) {
    const refundTruth = await loadEaserApplicationFeeRefundTruth({
      stripe,
      assemblerId,
      paymentIntentId: profile.stripe_payment_intent_id,
      customerId: profile.stripe_customer_id,
    });
    paymentIntent = refundTruth.paymentIntent;
    if (refundTruth.hasLiveRefundActivity) {
      throw new Error('Stripe shows refund activity for this application fee');
    }
  } else {
    paymentIntent = await stripe.paymentIntents.retrieve(profile.stripe_payment_intent_id);
    validateEaserApplicationPaymentIntent(paymentIntent, {
      userId: assemblerId,
      paymentIntentId: profile.stripe_payment_intent_id,
      customerId: profile.stripe_customer_id,
    });
    if (paymentIntent.status !== 'canceled') {
      throw new Error('A waived application still has an open or paid Stripe PaymentIntent');
    }
  }
  if (feePaid && profile.payment_confirmed !== true) {
    throw new Error('The paid application is not confirmed in database truth');
  }
  return { feeMode: feePaid ? 'paid' : 'waived', paymentIntentId: paymentIntent.id };
}

/**
 * POST /api/assembler/update
 * Owner-only: manage Easer status, tier, ID verification.
 *
 * CLEAN SEPARATION:
 *   status               — platform access: pending | active | suspended | rejected
 *   tier                 — quality level:   starter | professional | elite
 *   id_verification_status — identity:      pending | verified | failed
 *   has_membership       — subscription (managed by /api/assembler/membership)
 *
 * Actions:
 *   approve          → status=active, tier=starter (requires id_verified=true)
 *   reject           → status=rejected
 *   suspend          → status=suspended, saves previous_tier
 *   reinstate        → status=active, restores previous_tier (not forced to starter)
 *   promote          → tier upgrade (status must be active)
 *   demote           → tier downgrade (status must be active)
 *   mark_id_verified → id_verified=true, id_verification_status=verified
 *   delete           → archive account, revoke access, preserve business records
 *   retry_auth_revoke → retry sign-in revocation for an already archived account
 *   reconcile_application_fee_hold → fresh Stripe refund/dispute proof before clearing a failed-only hold
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { assemblerId, action, tier, rejectionReason } = req.body;
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });
  if (!action) return res.status(400).json({ error: 'action is required' });
  if (action === 'reject' && String(rejectionReason || '').length > 2000) {
    return res.status(400).json({ error: 'Rejection reason must be 2,000 characters or fewer.' });
  }

  const sb = getSupabase();

  const { data: rawProfile, error: lookupErr } = await sb
    .from('profiles')
    .select('*')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();

  if (lookupErr || !rawProfile) return res.status(404).json({ error: 'Easer not found' });
  let profile = normalizeAssemblerProfile(rawProfile);
  const closureStatus = normalizeEaserClosureStatus(profile);

  const closureBlockedActions = new Set([
    'approve',
    'reinstate',
    'promote',
    'demote',
    'mark_id_verified',
  ]);
  if (closureBlockedActions.has(action) && isEaserClosureBlocking(closureStatus)) {
    return res.status(409).json({
      error: `This Easer account has a ${closureStatus} closure status. Resolve the closure workflow before changing readiness or access.`,
      code: 'ACCOUNT_CLOSURE_BLOCKS_ACTION',
      closureStatus,
    });
  }

  if (action === 'reconcile_application_fee_hold') {
    if (!rawProfile.application_fee_refund_review_required_at) {
      return res.status(200).json({ ok: true, action, alreadyClear: true, isAvailable: rawProfile.is_available === true });
    }
    if (!process.env.STRIPE_SECRET_KEY
        || !rawProfile.stripe_payment_intent_id
        || !rawProfile.stripe_customer_id) {
      return res.status(503).json({
        error: 'The application-fee hold cannot be reconciled without its exact Stripe Customer and PaymentIntent.',
        code: 'APPLICATION_FEE_RECONCILIATION_UNAVAILABLE',
      });
    }

    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const refundTruth = await loadEaserApplicationFeeRefundTruth({
        stripe,
        assemblerId,
        paymentIntentId: rawProfile.stripe_payment_intent_id,
        customerId: rawProfile.stripe_customer_id,
      });
      await reconcileEaserApplicationFeeRefund(sb, {
        assemblerId,
        paymentIntentId: rawProfile.stripe_payment_intent_id,
        customerId: rawProfile.stripe_customer_id,
        truth: refundTruth,
        reason: 'Owner fresh application-fee financial-hold review',
      });
      const disputeTruth = await loadEaserApplicationFeeDisputeTruth({ stripe, paymentTruth: refundTruth });
      if (refundTruth.hasLiveRefundActivity || disputeTruth.hasBlockingDispute) {
        return res.status(409).json({
          error: 'Stripe still shows a pending/completed refund or unresolved dispute. The Easer remains offline for new work.',
          code: 'APPLICATION_FEE_FINANCIAL_HOLD_REMAINS',
          refundedCents: refundTruth.succeededRefundedCents,
          pendingRefundCents: refundTruth.pendingRefundCents,
          blockingDisputes: disputeTruth.blockingDisputes.map(dispute => ({
            id: dispute.id,
            status: dispute.status,
            amountCents: Number(dispute.amount || 0),
          })),
        });
      }

      const clearedAt = new Date().toISOString();
      const { data: cleared, error: clearError } = await sb.rpc('clear_easer_application_fee_financial_hold', {
        p_assembler_id: assemblerId,
        p_payment_intent_id: rawProfile.stripe_payment_intent_id,
        p_stripe_customer_id: rawProfile.stripe_customer_id,
        p_expected_review_required_at: rawProfile.application_fee_refund_review_required_at,
        p_cleared_at: clearedAt,
      });
      if (clearError || cleared !== true) {
        throw clearError || new Error('Application-fee hold clearance returned no authoritative result');
      }
      await logActivity(sb, {
        bookingId: null,
        eventType: 'easer_application_fee_financial_hold_cleared',
        actorType: 'owner',
        actorId: assemblerId,
        actorName: 'Owner',
        description: `Fresh Stripe truth showed no live application-fee refund or unresolved dispute for ${rawProfile.full_name || assemblerId}; the financial hold was cleared and availability remained off`,
        metadata: {
          paymentIntentId: rawProfile.stripe_payment_intent_id,
          failedOrCanceledRefundCount: refundTruth.refunds.length,
          resolvedDisputeCount: disputeTruth.disputes.length,
          isAvailable: false,
        },
      });
      const emailResult = rawProfile.email ? await sendEmail({
        to: rawProfile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        replyTo: ownerEmail(),
        subject: 'Application Fee Review Complete - AssembleAtEase',
        html: '<p>AssembleAtEase completed the Stripe review on your application fee. The financial hold has been cleared.</p><p>Your availability remains offline and your current application/account status has not otherwise changed. Contact support if you have questions.</p>',
        meta: {
          notificationType: 'easer_application_fee_hold_cleared',
          recipientType: 'easer',
          recipientUserId: assemblerId,
          disableDedupe: true,
        },
      }).catch(error => ({ ok: false, error: error?.message || String(error) })) : null;
      return res.status(200).json({
        ok: true,
        action,
        holdCleared: true,
        isAvailable: false,
        emailDelivered: !rawProfile.email || (emailResult?.ok === true && !emailResult?.suppressed),
      });
    } catch (error) {
      console.error('Application-fee financial-hold reconciliation failed:', error?.message || error);
      return res.status(['40001', '23514'].includes(error?.code) ? 409 : 503).json({
        error: 'Fresh Stripe refund and dispute truth could not safely clear this hold. The Easer remains offline.',
        code: 'APPLICATION_FEE_RECONCILIATION_FAILED',
      });
    }
  }

  // ── APPROVE ──────────────────────────────────────────────────────────────
  if (action === 'approve') {
    if (profile.status === 'active') {
      if (String(profile.application_status || '').toLowerCase() === 'approved') {
        try {
          await verifyApprovalStripeTruth(rawProfile, assemblerId);
        } catch (approvalTruthError) {
          const status = approvalTruthError?.status || 409;
          return res.status(status).json({
            error: approvalTruthError?.message || 'The active Easer application fee could not be verified.',
            code: 'APPLICATION_APPROVAL_TRUTH_MISMATCH',
          });
        }
        return res.status(200).json({
          ok: true,
          alreadyApproved: true,
          action: 'approved',
          status: 'active',
          tier: profile.tier || 'starter',
        });
      }
      return res.status(409).json({ error: 'The Easer access and application states disagree. Reconcile the profile before approval.' });
    }
    const approvalReadiness = await getEaserReadiness({
      ...profile,
      status: 'active',
      application_status: 'approved',
      tier: 'starter',
    }, { connectRequired: false, requireAvailability: false });
    if (!approvalReadiness.isReady) {
      return res.status(400).json({
        error: readinessError(approvalReadiness),
        missingItems: approvalReadiness.missingItems,
      });
    }

    const decision = 'approve';
    const resumingApproval = rawProfile.application_decision_type === decision
      && Boolean(rawProfile.application_decision_key);
    const operationKey = resumingApproval
      ? rawProfile.application_decision_key
      : applicationDecisionKey(assemblerId, decision);
    let claimResult;
    try {
      claimResult = await claimApplicationDecision(sb, {
        assemblerId,
        decision,
        operationKey,
        expectedProfile: rawProfile,
      });
    } catch (claimError) {
      console.error('approve decision claim error:', claimError);
      const failure = applicationDecisionHttpError(claimError, 'The application decision database migration is required before approving an Easer.');
      return res.status(failure.status).json({ error: failure.error, code: failure.code });
    }
    if (claimResult.result_action === 'already_finalized') {
      return res.status(200).json({ ok: true, alreadyApproved: true, action: 'approved', status: 'active', tier: 'starter' });
    }

    let approvalProfile;
    let approvalFinalizationStarted = false;
    try {
      approvalProfile = await loadRawEaserProfile(sb, assemblerId);
      profile = normalizeAssemblerProfile(approvalProfile);
      const finalReadiness = await getEaserReadiness({
        ...profile,
        status: 'active',
        application_status: 'approved',
        tier: 'starter',
      }, { connectRequired: false, requireAvailability: false });
      if (!finalReadiness.isReady) {
        const readinessFailure = new Error(readinessError(finalReadiness));
        readinessFailure.status = 400;
        readinessFailure.missingItems = finalReadiness.missingItems;
        throw readinessFailure;
      }

      // This live Stripe read is deliberately the final external check before
      // the row-locked database finalization. The expected snapshot makes any
      // intervening fee/refund/closure change lose the final CAS.
      await verifyApprovalStripeTruth(approvalProfile, assemblerId);
      approvalFinalizationStarted = true;
      const approvedProfile = await finalizeApplicationDecision(sb, {
        assemblerId,
        decision,
        operationKey,
        expectedProfile: approvalProfile,
      });
      if (approvedProfile.result_action === 'already_finalized') {
        return res.status(200).json({ ok: true, alreadyApproved: true, action: 'approved', status: 'active', tier: 'starter' });
      }
      if (approvedProfile.result_action !== 'applied') {
        throw new Error(`Unexpected approval finalization result: ${approvedProfile.result_action}`);
      }
    } catch (approveError) {
      console.error('approve decision validation/finalization error:', approveError);
      // Once the final RPC starts its response can be ambiguous. Keep the same
      // claim so a retry re-reads database truth with this exact operation key.
      // Before that point no external write occurred, so a failed validation
      // may safely release the claim and allow owner correction.
      const deterministicDatabaseRollback = approvalFinalizationStarted
        && ['40001', '23514'].includes(approveError?.code);
      if (!approvalFinalizationStarted || deterministicDatabaseRollback) {
        await releaseApplicationDecision(sb, { assemblerId, decision, operationKey })
          .catch(releaseError => console.error('approve decision release error:', releaseError));
      }
      const status = approveError?.status || (/Stripe|refund|fee|payment/i.test(approveError?.message || '') ? 409 : 503);
      return res.status(status).json({
        error: approveError?.message || 'The Easer could not be safely approved.',
        code: status === 400 ? 'EASER_NOT_READY' : 'APPLICATION_APPROVAL_TRUTH_MISMATCH',
        missingItems: approveError?.missingItems,
      });
    }

    sb.from('assembler_waitlist').delete().eq('email', profile.email.toLowerCase()).then(() => {});

    let resetUrl = SITE + '/auth/set-password';
    try {
      const { data: linkData } = await sb.auth.admin.generateLink({
        type: 'recovery',
        email: profile.email,
        options: { redirectTo: SITE + '/auth/set-password' },
      });
      if (linkData?.properties?.action_link) resetUrl = linkData.properties.action_link;
    } catch(e) { console.warn('generateLink error:', e.message); }

    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    const emailResult = await sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Welcome to AssembleAtEase — Set your password to get started',
      replyTo: 'service@assembleatease.com',
      html: buildApprovalEmail(firstName, profile.email, resetUrl),
      meta: {
        notificationType: 'approval',
        recipientType: 'easer',
        recipientUserId: assemblerId,
        disableDedupe: true,
      },
    }).catch(e => {
      console.error('Approval email send error:', e.message);
      return { ok: false, error: e.message };
    });

    // Gate flag on confirmed delivery — never mark sent before confirming
    const emailSent = emailResult?.ok === true && !emailResult?.suppressed;
    await sb.from('profiles').update({ welcome_email_sent: emailSent }).eq('id', assemblerId);

    if (!emailSent) {
      console.error('Approval email NOT delivered. result:', JSON.stringify(emailResult));
    }

    return res.status(200).json({
      ok: true,
      action: 'approved',
      status: 'active',
      tier: 'starter',
      emailDelivered: emailSent,
      emailError: emailSent ? null : (emailResult?.error || emailResult?.reason || 'unknown'),
    });
  }

  // ── REJECT ───────────────────────────────────────────────────────────────
  if (action === 'reject') {
    if (profile.status === 'active') {
      return res.status(400).json({ error: 'Cannot reject an active Easer. Use suspend instead.' });
    }

    const decision = 'reject';
    const resumingRejection = rawProfile.application_decision_type === decision
      && Boolean(rawProfile.application_decision_key);
    const operationKey = resumingRejection
      ? rawProfile.application_decision_key
      : applicationDecisionKey(assemblerId, decision);
    let claimResult;
    try {
      claimResult = await claimApplicationDecision(sb, {
        assemblerId,
        decision,
        operationKey,
        expectedProfile: rawProfile,
      });
    } catch (claimError) {
      console.error('reject decision claim error:', claimError);
      const failure = applicationDecisionHttpError(claimError, 'The application decision database migration is required before rejecting an Easer.');
      return res.status(failure.status).json({ error: failure.error, code: failure.code });
    }
    if (claimResult.result_action === 'already_finalized') {
      return res.status(200).json({
        ok: true,
        alreadyRejected: true,
        action: 'rejected',
        status: 'rejected',
        refundId: rawProfile.application_fee_refund_id || null,
      });
    }

    let rejectionProfile;
    try {
      rejectionProfile = await loadRawEaserProfile(sb, assemblerId);
      profile = normalizeAssemblerProfile(rejectionProfile);
    } catch (profileError) {
      if (!resumingRejection) {
        await releaseApplicationDecision(sb, { assemblerId, decision, operationKey }).catch(() => {});
      }
      return res.status(503).json({ error: 'The claimed application profile could not be re-read. No Stripe action was attempted.' });
    }
    let stripeMutationStarted = false;
    let stripeFinancialActivityObserved = false;
    const releaseDefinitivelySafeRejection = async () => {
      if (resumingRejection || stripeMutationStarted || stripeFinancialActivityObserved) return false;
      return releaseApplicationDecision(sb, { assemblerId, decision, operationKey });
    };

    // Stripe is authoritative. A succeeded application fee must be fully
    // refunded before rejection; an unfinished intent must be canceled first
    // so its browser client secret cannot charge after the owner rejects it.
    const feeWaived = profile.application_fee_waived === true
      || profile.fee_waived_by_owner === true;
    if (feeWaived && (profile.application_fee_paid === true || profile.payment_confirmed === true)) {
      return res.status(409).json({
        error: 'Application fee records show both a waiver and a payment. The application was not rejected; reconcile the profile and Stripe first.',
        code: 'APPLICATION_FEE_TRUTH_MISMATCH',
      });
    }
    const hasPaymentIntent = !!profile.stripe_payment_intent_id;
    let databaseClaimsPaid = profile.application_fee_paid === true
      || (!feeWaived && profile.payment_confirmed === true);
    let refundId = profile.application_fee_refund_id || null;
    let refundedCents = Number(profile.application_fee_refunded_cents || 0);
    let pendingRefundCents = Number(profile.application_fee_refund_pending_cents || 0);
    let refundedAt = profile.application_fee_refunded_at || null;
    let refundConfirmed = false;

    if ((profile.application_fee_refunded === true) !== (refundedCents > 0)
        || (refundedCents > 0) !== Boolean(refundId)
        || (refundedCents > 0) !== Boolean(refundedAt)
        || refundedCents < 0
        || pendingRefundCents < 0
        || refundedCents + pendingRefundCents > EASER_APPLICATION_FEE_CENTS) {
      return res.status(409).json({
        error: 'Application refund records are contradictory. The application was not rejected; reconcile the profile and Stripe first.',
        code: 'APPLICATION_REFUND_STATE_MISMATCH',
      });
    }

    if (hasPaymentIntent) {
      if (!process.env.STRIPE_SECRET_KEY || !profile.stripe_customer_id) {
        await releaseDefinitivelySafeRejection().catch(releaseError => {
          console.error('reject decision release error:', releaseError);
        });
        return res.status(503).json({
          error: 'The application payment cannot be verified against its stored Stripe Customer and PaymentIntent. The application was not rejected.',
          code: 'APPLICATION_REFUND_CONFIGURATION_REQUIRED',
        });
      }
      try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const paymentIntent = await stripe.paymentIntents.retrieve(profile.stripe_payment_intent_id);
        validateEaserApplicationPaymentIntent(paymentIntent, {
          userId: assemblerId,
          paymentIntentId: profile.stripe_payment_intent_id,
          customerId: profile.stripe_customer_id,
        });

        if (paymentIntent.status === 'succeeded') {
          stripeFinancialActivityObserved = true;
          if (feeWaived) {
            return res.status(409).json({
              error: 'Stripe shows a paid application but the profile also shows a fee waiver. The application was not rejected; reconcile and refund the charge first.',
              code: 'APPLICATION_FEE_TRUTH_MISMATCH',
            });
          }
          let refundTruth = await loadEaserApplicationFeeRefundTruth({
            stripe,
            assemblerId,
            paymentIntentId: profile.stripe_payment_intent_id,
            customerId: profile.stripe_customer_id,
          });
          await reconcileEaserApplicationFeeRefund(sb, {
            assemblerId,
            paymentIntentId: profile.stripe_payment_intent_id,
            customerId: profile.stripe_customer_id,
            truth: refundTruth,
            reason: 'Owner rejection application-fee refund reconciliation',
          });
          databaseClaimsPaid = true;
          refundedCents = refundTruth.succeededRefundedCents;
          pendingRefundCents = refundTruth.pendingRefundCents;
          refundId = refundTruth.latestSucceededRefundId;
          refundedAt = refundTruth.latestSucceededRefundedAt;

          if (pendingRefundCents > 0) {
            return res.status(409).json({
              error: 'Stripe is still processing an application-fee refund. The application was not rejected; retry after the pending refund resolves.',
              code: 'APPLICATION_REFUND_PENDING',
              refundId,
              refundedCents,
              pendingRefundCents,
            });
          }

          if (refundedCents < EASER_APPLICATION_FEE_CENTS) {
            const remainingCents = EASER_APPLICATION_FEE_CENTS - refundedCents;
            const failedOrCanceledCount = refundTruth.refunds.filter(refund => (
              ['failed', 'canceled'].includes(String(refund.status || '').toLowerCase())
              && refund.metadata?.userId === assemblerId
              && refund.metadata?.reason === 'application_rejected'
            )).length;
            stripeMutationStarted = true;
            await stripe.refunds.create({
              payment_intent: profile.stripe_payment_intent_id,
              amount: remainingCents,
              reason: 'requested_by_customer',
              metadata: {
                userId: assemblerId,
                reason: 'application_rejected',
                priorSucceededRefundedCents: String(refundedCents),
              },
            }, {
              idempotencyKey: `easer-application-rejection-refund-${assemblerId}-from-${refundedCents}-v${failedOrCanceledCount + 1}`,
            });

            refundTruth = await loadEaserApplicationFeeRefundTruth({
              stripe,
              assemblerId,
              paymentIntentId: profile.stripe_payment_intent_id,
              customerId: profile.stripe_customer_id,
            });
            await reconcileEaserApplicationFeeRefund(sb, {
              assemblerId,
              paymentIntentId: profile.stripe_payment_intent_id,
              customerId: profile.stripe_customer_id,
              truth: refundTruth,
              reason: 'Owner rejection application-fee refund reconciliation',
            });
            refundedCents = refundTruth.succeededRefundedCents;
            pendingRefundCents = refundTruth.pendingRefundCents;
            refundId = refundTruth.latestSucceededRefundId;
            refundedAt = refundTruth.latestSucceededRefundedAt;
          }

          if (pendingRefundCents > 0) {
            return res.status(409).json({
              error: 'Stripe is still processing the remaining application-fee refund. The application was not rejected; retry after it succeeds.',
              code: 'APPLICATION_REFUND_PENDING',
              refundId,
              refundedCents,
              pendingRefundCents,
            });
          }
          if (refundedCents !== EASER_APPLICATION_FEE_CENTS || !refundId || !refundedAt) {
            throw new Error(`Stripe aggregate refund is ${refundedCents} of ${EASER_APPLICATION_FEE_CENTS} cents`);
          }
          refundConfirmed = true;
        } else if (paymentIntent.status === 'canceled') {
          if (databaseClaimsPaid || refundedCents > 0 || pendingRefundCents > 0 || refundId
              || profile.application_fee_refund_review_required_at) {
            return res.status(409).json({
              error: 'The profile reports paid or refunded money but Stripe shows a canceled application payment. The application was not rejected; reconcile first.',
              code: 'APPLICATION_FEE_TRUTH_MISMATCH',
            });
          }
        } else {
          if (databaseClaimsPaid || refundedCents > 0 || pendingRefundCents > 0 || refundId
              || profile.application_fee_refund_review_required_at) {
            return res.status(409).json({
              error: 'The profile payment state disagrees with Stripe. The application was not rejected; reconcile first.',
              code: 'APPLICATION_FEE_TRUTH_MISMATCH',
            });
          }
          stripeMutationStarted = true;
          const canceledIntent = await stripe.paymentIntents.cancel(
            profile.stripe_payment_intent_id,
            {},
            { idempotencyKey: `easer-application-rejection-cancel-${assemblerId}` },
          );
          if (canceledIntent?.status !== 'canceled') {
            throw new Error(`Stripe returned PaymentIntent status ${canceledIntent?.status || 'unknown'} after cancellation`);
          }
        }
      } catch (refundErr) {
        console.error(`[reject] Stripe payment reconciliation failed for ${profile.email}:`, refundErr.message);
        return res.status(502).json({
          error: 'Stripe could not safely cancel or refund the application payment. The application was not rejected; retry after reviewing Stripe.',
          code: 'APPLICATION_REFUND_FAILED',
        });
      }
    } else if (databaseClaimsPaid || refundedCents > 0 || pendingRefundCents > 0 || refundId
        || profile.application_fee_refund_review_required_at) {
      return res.status(409).json({
        error: 'The profile reports paid or refunded money but has no stored Stripe PaymentIntent. The application was not rejected; reconcile first.',
        code: 'APPLICATION_FEE_TRUTH_MISMATCH',
      });
    }

    if (!feeWaived && databaseClaimsPaid && !refundConfirmed) {
      // This should be unreachable after the Stripe checks above. Keep a final
      // fail-closed guard so a future edit cannot reject a known paid applicant.
      return res.status(409).json({
        error: 'The paid application has no confirmed full Stripe refund. The application was not rejected.',
        code: 'APPLICATION_REFUND_REQUIRED',
      });
    }

    let finalRejectionProfile;
    try {
      finalRejectionProfile = await loadRawEaserProfile(sb, assemblerId);
      const finalized = await finalizeApplicationDecision(sb, {
        assemblerId,
        decision,
        operationKey,
        expectedProfile: finalRejectionProfile,
        refundId: refundConfirmed ? refundId : null,
        refundedAt: refundConfirmed
          ? (finalRejectionProfile.application_fee_refunded_at || new Date().toISOString())
          : null,
        rejectionReason: rejectionReason?.trim() || null,
      });
      if (finalized.result_action === 'already_finalized') {
        return res.status(200).json({
          ok: true,
          alreadyRejected: true,
          action: 'rejected',
          status: 'rejected',
          refundId: finalized.application_fee_refund_id || refundId || null,
        });
      }
      if (finalized.result_action !== 'applied') {
        throw new Error(`Unexpected rejection finalization result: ${finalized.result_action}`);
      }
    } catch (rejectErr) {
      // Keep the exact rejection claim after any Stripe mutation or ambiguous
      // financial read. A retry resumes the same idempotent operation instead
      // of allowing a conflicting approval to activate the Easer.
      console.error('reject decision finalization error:', rejectErr);
      return res.status(500).json({
        error: refundConfirmed
          ? 'The fee was refunded, but rejection status could not be saved. Retry this same action; Stripe will not refund twice.'
          : 'The rejection could not be finalized. Retry this same action.',
        code: refundConfirmed ? 'APPLICATION_REJECTION_PERSIST_FAILED' : 'APPLICATION_REJECTION_FAILED',
        refundId: refundConfirmed ? refundId : null,
      });
    }

    sb.from('assembler_waitlist').update({ status: 'rejected' }).eq('email', profile.email.toLowerCase()).then(() => {});

    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    const rejectionEmail = await sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your AssembleAtEase Application',
      replyTo: 'service@assembleatease.com',
      html: buildRejectionEmail(firstName, rejectionReason?.trim() || null, refundConfirmed, feeWaived),
      meta: { notificationType: 'easer_application_rejected', recipientType: 'easer', recipientUserId: assemblerId, disableDedupe: true },
    }).catch(e => ({ ok: false, error: e?.message || String(e) }));

    return res.status(200).json({ ok: true, action: 'rejected', status: 'rejected', refundId, emailDelivered: rejectionEmail?.ok === true && !rejectionEmail?.suppressed });
  }

  // ── SUSPEND ──────────────────────────────────────────────────────────────
  if (action === 'suspend') {
    if (profile.status === 'suspended') return res.status(200).json({
      ok: true,
      alreadySuspended: true,
      action: 'suspended',
      previous_tier: profile.previous_tier || null,
    });
    if (profile.status !== 'active') return res.status(400).json({ error: 'Only active Easers can be suspended.' });

    // The RPC takes the same profile row lock as the booking-assignment trigger.
    // Whichever operation wins is authoritative: assignment makes suspension
    // observe the active job; suspension makes assignment observe ineligibility.
    const { data: suspensionData, error: suspendErr } = await sb.rpc('suspend_easer_if_no_active_jobs', {
      p_assembler_id: assemblerId,
      p_expected_status: rawProfile.status ?? null,
      p_expected_tier: rawProfile.tier ?? null,
    });
    if (suspendErr) {
      console.error('suspend RPC error:', suspendErr);
      const conflict = suspendErr.code === '40001'
        || suspendErr.code === '23514'
        || /changed|active job|assignment|decision/i.test(suspendErr.message || '');
      return res.status(conflict ? 409 : 503).json({
        error: conflict
          ? 'The Easer state changed while suspension was being applied. Refresh and review current assignments.'
          : 'The suspension safety migration is required before suspending an Easer.',
        code: conflict ? 'EASER_SUSPENSION_CONFLICT' : 'EASER_SUSPENSION_DATABASE_REQUIRED',
      });
    }
    const suspension = Array.isArray(suspensionData) ? suspensionData[0] : suspensionData;
    if (!suspension?.result_action) {
      return res.status(503).json({
        error: 'Suspension returned no authoritative database result.',
        code: 'EASER_SUSPENSION_DATABASE_REQUIRED',
      });
    }
    if (suspension.result_action === 'active_jobs') {
      const activeJobs = Array.isArray(suspension.active_jobs) ? suspension.active_jobs : [];
      return res.status(409).json({
        error: `Cannot suspend — this Easer has ${activeJobs.length} active job(s). Reassign or complete them first.`,
        activeJobs,
        code: 'EASER_HAS_ACTIVE_JOBS',
      });
    }
    if (!['suspended', 'already_suspended'].includes(suspension.result_action)) {
      return res.status(503).json({
        error: `Unexpected suspension result: ${suspension.result_action}`,
        code: 'EASER_SUSPENSION_DATABASE_REQUIRED',
      });
    }

    const { suspensionNotes } = req.body;
    if (suspensionNotes?.trim()) console.log(`[suspend] ${profile.full_name} (${assemblerId}): ${suspensionNotes.trim()}`);

    return res.status(200).json({
      ok: true,
      alreadySuspended: suspension.result_action === 'already_suspended',
      action: 'suspended',
      previous_tier: suspension.previous_tier || null,
    });
  }

  // ── REINSTATE ────────────────────────────────────────────────────────────
  if (action === 'reinstate') {
    if (profile.status !== 'suspended' && profile.tier !== 'suspended') {
      return res.status(400).json({ error: 'Easer is not suspended.' });
    }

    const restoredTier = getRestorableTier(profile);
    const { data: reinstatedProfile, error: reinstateErr } = await sb.from('profiles')
      .update({
        tier: restoredTier,
        status: 'active',
        previous_tier: null,
      })
      .eq('id', assemblerId)
      .or('account_closure_status.is.null,account_closure_status.eq.cancelled')
      .select('id')
      .maybeSingle();
    if (reinstateErr) {
      console.error('reinstate update error:', reinstateErr);
      return res.status(500).json({ error: 'Failed to reinstate Easer' });
    }
    if (!reinstatedProfile) return respondWithOwnerClosureRace(res);

    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    const tierLabel = { starter: 'Starter', professional: 'Professional', elite: 'Elite' }[restoredTier] || restoredTier;
    const reinstateEmail = await sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your AssembleAtEase account has been reinstated',
      replyTo: 'service@assembleatease.com',
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem"><h2 style="color:#00BFFF">Account Reinstated</h2><p>Hi ${esc(firstName)},</p><p>Your account has been reinstated as a <strong>${esc(tierLabel)}</strong> Easer. Review your readiness checklist, then switch to Online when you are ready to receive offers.</p><p><a href="${SITE}/assembler/" style="color:#00BFFF">Open your dashboard</a></p></div>`,
      meta: { notificationType: 'easer_reinstated', recipientType: 'easer', recipientUserId: assemblerId, disableDedupe: true },
    }).catch(e => ({ ok: false, error: e?.message || String(e) }));

    return res.status(200).json({ ok: true, action: 'reinstated', status: 'active', tier: restoredTier, emailDelivered: reinstateEmail?.ok === true && !reinstateEmail?.suppressed });
  }

  // ── PROMOTE / DEMOTE ─────────────────────────────────────────────────────
  if (action === 'promote' || action === 'demote') {
    if (profile.status !== 'active') {
      return res.status(400).json({ error: 'Only active Easers can have their tier changed.' });
    }

    const validTiers = ACTIVE_EASER_TIERS;
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({ error: 'tier must be one of: starter, professional, elite' });
    }

    const tierRank = { starter: 1, professional: 2, elite: 3 };
    const currentRank = tierRank[profile.tier] || 0;
    const newRank = tierRank[tier];

    if (action === 'promote' && newRank <= currentRank) {
      return res.status(400).json({ error: `Cannot promote to ${tier} — must be higher than current tier (${profile.tier}).` });
    }
    if (action === 'demote' && newRank >= currentRank) {
      return res.status(400).json({ error: `Cannot demote to ${tier} — must be lower than current tier (${profile.tier}).` });
    }

    const { data: tierChangedProfile, error: tierChangeError } = await sb.from('profiles')
      .update({ tier })
      .eq('id', assemblerId)
      .or('account_closure_status.is.null,account_closure_status.eq.cancelled')
      .select('id')
      .maybeSingle();
    if (tierChangeError) {
      console.error(`${action} update error:`, tierChangeError);
      return res.status(500).json({ error: `Failed to ${action} Easer` });
    }
    if (!tierChangedProfile) return respondWithOwnerClosureRace(res);

    const tierLabel = { starter: 'Starter', professional: 'Professional', elite: 'Elite' }[tier];
    const firstName = (profile.full_name || '').split(' ')[0] || 'there';

    if (action === 'promote') {
      await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Congratulations — you've been promoted to ${tierLabel}`,
        replyTo: 'service@assembleatease.com',
        html: buildPromotionEmail(firstName, tierLabel, tier),
        meta: { notificationType: 'easer_tier_changed', recipientType: 'easer', recipientUserId: assemblerId, disableDedupe: true },
      }).catch(() => ({ ok: false }));
    }

    return res.status(200).json({ ok: true, action, tier, previous: profile.tier });
  }

  // ── MARK ID VERIFIED ─────────────────────────────────────────────────────
  if (action === 'mark_id_verified') {
    // Always update identity_verified first (this column definitely exists)
    const { data: verifiedProfile, error: idErr } = await sb.from('profiles')
      .update({
        identity_verified: true,
        identity_verified_at: new Date().toISOString(),
      })
      .eq('id', assemblerId)
      .or('account_closure_status.is.null,account_closure_status.eq.cancelled')
      .select('id')
      .maybeSingle();
    if (idErr) {
      console.error('mark_id_verified core update error:', idErr);
      return res.status(500).json({ error: 'Failed to update identity_verified' });
    }
    if (!verifiedProfile) return respondWithOwnerClosureRace(res);
    // Best-effort: also update new columns if they exist
    await sb.from('profiles')
      .update({ id_verification_status: 'verified' })
      .eq('id', assemblerId)
      .or('account_closure_status.is.null,account_closure_status.eq.cancelled');

    const ownerNotice = await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `ID Verified — ${esc(profile.full_name)} ready to approve`,
      html: `<div style="font-family:sans-serif;padding:1.5rem"><p><strong>${esc(profile.full_name)}</strong> identity manually verified. They can now be approved. <a href="${SITE}/owner/" style="color:#00BFFF">Open dashboard</a></p></div>`,
      meta: { notificationType: 'easer_identity_verified', recipientType: 'owner', recipientUserId: assemblerId, disableDedupe: true },
    }).catch(e => ({ ok: false, error: e?.message || String(e) }));

    return res.status(200).json({ ok: true, action: 'id_verified', identity_verified: true, ownerNotified: ownerNotice?.ok === true && !ownerNotice?.suppressed });
  }

  // ── CLOSE / ARCHIVE ACCOUNT ─────────────────────────────────────────────
  if (action === 'delete' || action === 'retry_auth_revoke') {
    if (action === 'retry_auth_revoke' && closureStatus !== 'completed') {
      return res.status(409).json({
        error: 'Sign-in revocation can only be retried after the Easer account is archived.',
        code: 'ACCOUNT_NOT_ARCHIVED',
        closureStatus,
      });
    }

    const { data: liveJobs, error: liveJobsError } = await sb
      .from('bookings')
      .select('id, ref, service, date')
      .eq('assembler_id', assemblerId)
      .in('status', ['confirmed', 'en_route', 'arrived', 'in_progress']);
    if (liveJobsError) return res.status(500).json({ error: 'Could not verify active assignments.' });
    if (liveJobs?.length) {
      return res.status(409).json({
        error: `Cannot close this account - the Easer has ${liveJobs.length} active job(s). Reassign or complete them first.`,
        activeJobs: liveJobs.map(b => ({ ref: b.ref, service: b.service, date: b.date })),
      });
    }

    let finance;
    try {
      finance = await loadLedgerFirstFinanceRows(sb);
    } catch (error) {
      console.error('[archive] Easer payout reconciliation failed:', error?.message || error);
      return res.status(503).json({
        error: 'Payout records could not be reconciled. The account was not archived and sign-in access was not changed.',
        code: 'PAYOUT_RECONCILIATION_UNAVAILABLE',
      });
    }
    const unpaidEarnings = (finance.rows || []).filter(row => (
      row.assemblerId === assemblerId
      && !row.paidOut
      && ['pending', 'on_hold'].includes(row.payoutDisposition)
      && Number(row.owed || 0) > 0
    ));
    if (unpaidEarnings.length) {
      return res.status(409).json({
        error: 'This Easer has unpaid earnings. Record each payout before archiving the account or revoking sign-in access.',
        code: 'EASER_UNPAID_EARNINGS',
        totalPendingCents: unpaidEarnings.reduce((sum, row) => sum + Number(row.owed || 0), 0),
        unpaidEarnings: unpaidEarnings.slice(0, 25).map(row => ({
          ref: row.ref,
          eventType: row.eventType,
          amountCents: Number(row.owed || 0),
          payoutStatus: row.payoutStatus || 'pending',
          payoutDisposition: row.payoutDisposition,
          payoutReviewStatus: row.payoutReviewStatus || null,
        })),
      });
    }

    const applicationStatus = String(rawProfile.application_status || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(applicationStatus)) {
      return res.status(409).json({
        error: 'This is still an open application. Reject it first so any application PaymentIntent is safely canceled or refunded before archiving.',
        code: 'APPLICATION_REJECTION_REQUIRED',
        applicationStatus: applicationStatus || null,
      });
    }
    const storedPlatformStatus = String(rawProfile.status || '').trim().toLowerCase();
    const applicationStateConsistent = applicationStatus === 'approved'
      ? ['active', 'suspended'].includes(storedPlatformStatus)
      : storedPlatformStatus === 'rejected';
    if (!applicationStateConsistent) {
      return res.status(409).json({
        error: 'The stored application and platform statuses disagree. Resolve the application decision before archiving or revoking sign-in access.',
        code: 'APPLICATION_STATE_MISMATCH',
        applicationStatus,
        platformStatus: storedPlatformStatus || null,
      });
    }

    if (applicationStatus === 'rejected') {
      const applicationPaymentGuard = await verifyRejectedApplicationPaymentClosed(rawProfile, assemblerId, sb);
      if (!applicationPaymentGuard.ok) {
        return res.status(applicationPaymentGuard.status).json({
          error: applicationPaymentGuard.error,
          code: applicationPaymentGuard.code,
        });
      }
    }

    if (closureStatus === 'completed') {
      if (rawProfile.auth_access_revoked_at) {
        return res.status(200).json({
          ok: true,
          action: action === 'retry_auth_revoke' ? 'auth_access_already_revoked' : 'account_already_archived',
          recordsPreserved: true,
          alreadyArchived: true,
          authAccess: {
            revoked: true,
            revokedAt: rawProfile.auth_access_revoked_at,
            error: null,
            diagnosticPersistenceError: null,
          },
        });
      }

      const retryAt = new Date().toISOString();
      const retryResult = await revokeEaserAuthAccess(sb, assemblerId, retryAt);
      const retryPayload = {
        ok: retryResult.revoked,
        action: 'auth_access_revoke_retried',
        recordsPreserved: true,
        accountArchived: true,
        accessRevoked: retryResult.revoked,
        authAccess: retryResult,
      };
      if (!retryResult.revoked) {
        return res.status(502).json({
          ...retryPayload,
          error: 'The account remains archived, but sign-in access could not be revoked. Review the saved diagnostic and retry.',
          code: 'AUTH_ACCESS_REVOCATION_FAILED',
        });
      }
      return res.status(200).json({
        ...retryPayload,
        warning: retryResult.diagnosticPersistenceError
          ? 'auth_access_revocation_audit_failed'
          : null,
      });
    }

    const closedAt = new Date().toISOString();
    const archiveUpdates = {
      status: 'suspended',
      tier: 'suspended',
      previous_tier: getPreservedTier(profile),
      is_available: false,
      account_closure_status: 'completed',
      account_closure_requested_at: profile.account_closure_requested_at || closedAt,
      account_closure_reviewed_at: closedAt,
      account_closure_completed_at: closedAt,
      account_closure_completed_by: 'owner',
      auth_access_revoke_error: null,
    };
    let profileCloseQuery = sb.from('profiles')
      .update(archiveUpdates)
      .eq('id', assemblerId)
      .eq('role', 'assembler');
    profileCloseQuery = rawProfile.status == null
      ? profileCloseQuery.is('status', null)
      : profileCloseQuery.eq('status', rawProfile.status);
    profileCloseQuery = rawProfile.account_closure_status == null
      ? profileCloseQuery.is('account_closure_status', null)
      : profileCloseQuery.eq('account_closure_status', rawProfile.account_closure_status);
    const { data: archivedProfile, error: profileCloseError } = await profileCloseQuery
      .select('id')
      .maybeSingle();
    if (profileCloseError) {
      console.error('[archive] Easer profile close failed:', profileCloseError.message || profileCloseError);
      const closeError = String(profileCloseError.message || '');
      const activeAssignmentRace = /active assignment|live assignment/i.test(closeError);
      const unpaidEarningsRace = /earnings remain unpaid|unpaid earnings/i.test(closeError);
      return res.status(activeAssignmentRace || unpaidEarningsRace ? 409 : 500).json({
        error: activeAssignmentRace
          ? 'A live assignment was created while closure was being reviewed. Reassign or complete it before retrying.'
          : unpaidEarningsRace
            ? 'New unpaid Easer earnings were recorded while closure was being reviewed. Reconcile and record the payout before retrying.'
            : 'Failed to archive Easer account.',
        code: activeAssignmentRace
          ? 'ACCOUNT_ARCHIVE_ACTIVE_ASSIGNMENTS'
          : unpaidEarningsRace
            ? 'EASER_UNPAID_EARNINGS'
            : 'ACCOUNT_ARCHIVE_FAILED',
      });
    }
    if (!archivedProfile) {
      return res.status(409).json({
        error: 'The Easer profile changed while closure was being reviewed. Nothing was archived; refresh and retry.',
        code: 'ACCOUNT_ARCHIVE_STATE_CHANGED',
      });
    }

    const revokeResult = await revokeEaserAuthAccess(sb, assemblerId, closedAt);
    const warning = !revokeResult.revoked
      ? 'auth_access_revocation_failed'
      : (revokeResult.diagnosticPersistenceError ? 'auth_access_revocation_audit_failed' : null);

    return res.status(200).json({
      ok: true,
      action: 'account_archived',
      recordsPreserved: true,
      accessRevoked: revokeResult.revoked,
      authAccess: revokeResult,
      warning,
    });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}

function respondWithOwnerClosureRace(res) {
  return res.status(409).json({
    error: 'The account closure status changed before this owner action could be saved. Refresh the Easer record and resolve the closure workflow first.',
    code: 'ACCOUNT_CLOSURE_BLOCKS_ACTION',
  });
}

async function verifyRejectedApplicationPaymentClosed(profile, assemblerId, sb) {
  const feeWaived = profile.application_fee_waived === true
    || profile.fee_waived_by_owner === true;
  const databaseClaimsPaid = profile.application_fee_paid === true
    || (!feeWaived && profile.payment_confirmed === true);
  const refundId = profile.application_fee_refund_id || null;
  const databaseClaimsRefunded = profile.application_fee_refunded === true;
  const storedRefundedCents = Number(profile.application_fee_refunded_cents || 0);
  const storedPendingRefundCents = Number(profile.application_fee_refund_pending_cents || 0);

  if (databaseClaimsRefunded !== (storedRefundedCents > 0)
      || (storedRefundedCents > 0) !== Boolean(refundId)
      || (storedRefundedCents > 0) !== Boolean(profile.application_fee_refunded_at)
      || storedRefundedCents < 0
      || storedPendingRefundCents < 0
      || storedRefundedCents + storedPendingRefundCents > EASER_APPLICATION_FEE_CENTS) {
    return archiveGuardFailure(
      409,
      'APPLICATION_REFUND_STATE_MISMATCH',
      'Application refund records are contradictory. Reconcile the profile and Stripe before archiving.',
    );
  }

  if (!profile.stripe_payment_intent_id) {
    if (databaseClaimsPaid || databaseClaimsRefunded || refundId
        || storedRefundedCents > 0 || storedPendingRefundCents > 0
        || profile.application_fee_refund_review_required_at) {
      return archiveGuardFailure(
        409,
        'APPLICATION_FEE_TRUTH_MISMATCH',
        'The rejected application reports paid or refunded money but has no stored Stripe PaymentIntent. Reconcile it before archiving.',
      );
    }
    return { ok: true };
  }

  if (!process.env.STRIPE_SECRET_KEY || !profile.stripe_customer_id) {
    return archiveGuardFailure(
      503,
      'APPLICATION_PAYMENT_VERIFICATION_UNAVAILABLE',
      'The rejected application payment cannot be verified against Stripe. The account was not archived.',
    );
  }

  let stripe;
  let paymentIntent;
  try {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    paymentIntent = await stripe.paymentIntents.retrieve(profile.stripe_payment_intent_id);
    validateEaserApplicationPaymentIntent(paymentIntent, {
      userId: assemblerId,
      paymentIntentId: profile.stripe_payment_intent_id,
      customerId: profile.stripe_customer_id,
    });
  } catch (error) {
    console.error('[archive] Rejected application PaymentIntent verification failed:', error?.message || error);
    return archiveGuardFailure(
      502,
      'APPLICATION_PAYMENT_VERIFICATION_FAILED',
      'Stripe could not verify the rejected application payment. The account was not archived.',
    );
  }

  if (paymentIntent.status === 'canceled') {
    if (databaseClaimsPaid || databaseClaimsRefunded || refundId
        || storedRefundedCents > 0 || storedPendingRefundCents > 0
        || profile.application_fee_refund_review_required_at) {
      return archiveGuardFailure(
        409,
        'APPLICATION_FEE_TRUTH_MISMATCH',
        'The profile reports paid or refunded money but Stripe shows a canceled application payment. Reconcile it before archiving.',
      );
    }
    return { ok: true };
  }

  if (paymentIntent.status !== 'succeeded') {
    return archiveGuardFailure(
      409,
      'APPLICATION_PAYMENT_CANCELLATION_REQUIRED',
      'The rejected application still has an open Stripe PaymentIntent. Retry Reject to cancel it before archiving.',
    );
  }

  if (feeWaived) {
    return archiveGuardFailure(
      409,
      'APPLICATION_FEE_TRUTH_MISMATCH',
      'Stripe shows a paid application, but the profile payment or waiver state disagrees. Reconcile it before archiving.',
    );
  }

  try {
    const refundTruth = await loadEaserApplicationFeeRefundTruth({
      stripe,
      assemblerId,
      paymentIntentId: profile.stripe_payment_intent_id,
      customerId: profile.stripe_customer_id,
    });
    const reconciled = await reconcileEaserApplicationFeeRefund(sb, {
      assemblerId,
      paymentIntentId: profile.stripe_payment_intent_id,
      customerId: profile.stripe_customer_id,
      truth: refundTruth,
      reason: 'Archived rejected application payment verification',
    });
    if (!databaseClaimsPaid && reconciled.refunded_cents <= 0) {
      return archiveGuardFailure(
        409,
        'APPLICATION_FEE_TRUTH_MISMATCH',
        'Stripe shows a paid application, but its payment truth could not be reconciled before archiving.',
      );
    }
    if (!refundTruth.fullyRefunded
        || refundTruth.pendingRefundCents !== 0
        || !refundTruth.latestSucceededRefundId
        || Number(reconciled.refunded_cents || 0) !== EASER_APPLICATION_FEE_CENTS
        || Number(reconciled.pending_refund_cents || 0) !== 0
        || reconciled.refund_id !== refundTruth.latestSucceededRefundId) {
      return archiveGuardFailure(
        409,
        'APPLICATION_REFUND_PAYMENT_MISMATCH',
        'The application does not have a completed full aggregate Stripe refund. Retry Reject before archiving.',
      );
    }
  } catch (error) {
    console.error('[archive] Aggregate application refund verification failed:', error?.message || error);
    return archiveGuardFailure(
      502,
      'APPLICATION_REFUND_VERIFICATION_FAILED',
      'Stripe could not verify the application refund. The account was not archived.',
    );
  }

  return { ok: true };
}

function archiveGuardFailure(status, code, error) {
  return { ok: false, status, code, error };
}

function isMissingAuthUserError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || error || '');
  return status === 404 || /user[^\n]*not found|not found[^\n]*user/i.test(message);
}

async function revokeEaserAuthAccess(sb, assemblerId, revokedAt) {
  let authError = null;
  try {
    const { error } = await sb.auth.admin.deleteUser(assemblerId, true);
    if (error && !isMissingAuthUserError(error)) throw error;
  } catch (error) {
    authError = String(error?.message || 'Auth access revocation failed').slice(0, 2000);
  }

  if (authError) {
    const { error: diagnosticError } = await sb.from('profiles')
      .update({ auth_access_revoke_error: authError })
      .eq('id', assemblerId)
      .eq('role', 'assembler')
      .eq('account_closure_status', 'completed');
    return {
      revoked: false,
      revokedAt: null,
      error: authError,
      diagnosticPersistenceError: diagnosticError?.message || null,
    };
  }

  const { data: diagnosticRow, error: diagnosticError } = await sb.from('profiles')
    .update({
      auth_access_revoked_at: revokedAt,
      auth_access_revoke_error: null,
    })
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .eq('account_closure_status', 'completed')
    .select('id')
    .maybeSingle();
  return {
    revoked: true,
    revokedAt,
    error: null,
    diagnosticPersistenceError: diagnosticError?.message
      || (!diagnosticRow ? 'Archived profile no longer matched the auth diagnostic update.' : null),
  };
}

function buildApprovalEmail(firstName, email, resetUrl) {
  const steps = [
    { num: '1', title: 'Set your password', desc: 'Click the button below to create your password and log into your Easer dashboard.' },
    { num: '2', title: 'Complete your profile', desc: 'Add your profile photo and confirm your phone number and city in the Profile section.' },
    { num: '3', title: 'Go Online', desc: 'Tap the "Offline" pill on your dashboard home screen to switch to Online. You will not receive job offers while offline.' },
    { num: '4', title: 'Wait for your first offer', desc: 'When a matching job is dispatched, AssembleAtEase sends the offer by email with a 20-minute acceptance window. If notifications are configured and enabled on your device, you will also receive a push alert.' },
  ];
  const stepsHtml = steps.map(s => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;width:32px">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#00BFFF;color:#fff;font-size:0.75rem;font-weight:700">${s.num}</span>
      </td>
      <td style="padding:10px 0 10px 12px;border-bottom:1px solid #f0f0f0">
        <div style="font-size:0.875rem;font-weight:700;color:#111;margin-bottom:2px">${s.title}</div>
        <div style="font-size:0.82rem;color:#52525b;line-height:1.55">${s.desc}</div>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden">
    <div style="background:linear-gradient(135deg,#003d47,#00BFFF);padding:2rem;text-align:center">
      <img src="${LOGO}" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <h1 style="color:#fff;margin:12px 0 0;font-size:1.4rem">Welcome to AssembleAtEase!</h1>
    </div>
    <div style="padding:2rem">
      <p style="font-size:1rem;font-weight:700;margin:0 0 8px">Congratulations, ${esc(firstName)}!</p>
      <p style="color:#52525b;line-height:1.7;margin:0 0 20px">Your application has been approved. You are now an official <strong>Starter Easer</strong> on AssembleAtEase. Here is what to do next to start receiving jobs:</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:1.5rem">
        ${stepsHtml}
      </table>

      <div style="background:#e0f2fe;border:1px solid #7dd3fc;border-radius:8px;padding:12px 16px;margin-bottom:20px">
        <p style="margin:0;font-size:0.82rem;color:#0c4a6e;font-weight:700">Important: You start Offline by default.</p>
        <p style="margin:4px 0 0;font-size:0.82rem;color:#0369a1;line-height:1.5">You will not appear in dispatch and will not receive job offers until you manually switch to Online in your dashboard.</p>
      </div>

      <div style="text-align:center;margin:1.5rem 0">
        <a href="${resetUrl}" style="display:inline-block;background:#00BFFF;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:1rem;font-weight:700">Set Password &amp; Open Dashboard</a>
      </div>

      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;padding:12px 16px;margin-bottom:20px">
        <p style="margin:0;font-size:0.82rem;color:#92400e">This link expires in 24 hours. Use <a href="${SITE}/auth/forgot-password" style="color:#92400e">forgot password</a> if it expires.</p>
      </div>

      <p style="font-size:0.85rem;color:#71717a;margin:0"><strong>Your login:</strong> ${esc(email)}</p>
      <p style="font-size:0.82rem;color:#71717a;margin:8px 0 0">Questions? Email <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a></p>
    </div>
  </div>
</div></body></html>`;
}

function buildPromotionEmail(firstName, tierLabel, tier) {
  const perks = {
    professional: [
      'Higher dispatch priority — you rank above Starter Easers for every job',
      'Access to larger, higher-value service requests',
      'Increased earning potential per completed job',
    ],
    elite: [
      'Top dispatch priority across the entire platform',
      'First access to premium and same-day jobs',
      'Highest earning rate and dedicated support',
    ],
  };
  const tierColor = tier === 'elite' ? '#92400e' : '#5b21b6';
  const tierBg    = tier === 'elite' ? '#fef3c7' : '#ede9fe';
  const items = (perks[tier] || ['You now have an elevated tier on AssembleAtEase.']).map(p =>
    `<li style="margin-bottom:8px;color:#374151">${p}</li>`
  ).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#003d47,#00BFFF);padding:2rem;text-align:center">
      <img src="${LOGO}" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <h1 style="color:#fff;margin:12px 0 0;font-size:1.4rem;font-weight:700">You've been promoted</h1>
    </div>

    <!-- Body -->
    <div style="padding:2rem">
      <p style="font-size:1rem;font-weight:700;margin:0 0 6px">Congratulations, ${esc(firstName)}!</p>
      <p style="color:#52525b;line-height:1.7;margin:0 0 1.25rem">
        Your dedication and service quality have earned you a tier upgrade. You are now a
        <strong style="color:${tierColor}">${esc(tierLabel)} Easer</strong> on AssembleAtEase.
      </p>

      <!-- Tier badge -->
      <div style="text-align:center;margin:0 0 1.5rem">
        <span style="display:inline-block;background:${tierBg};color:${tierColor};font-size:1rem;font-weight:700;padding:10px 32px;border-radius:999px;letter-spacing:0.04em;text-transform:uppercase">
          ${esc(tierLabel)}
        </span>
      </div>

      <!-- What this means -->
      <div style="background:#f9fafb;border:1px solid #e4e4e7;border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.5rem">
        <p style="margin:0 0 10px;font-size:0.875rem;font-weight:700;color:#111;text-transform:uppercase;letter-spacing:0.06em">What this means for you</p>
        <ul style="margin:0;padding-left:1.25rem;font-size:0.9rem;line-height:1.7">
          ${items}
        </ul>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin:1.5rem 0">
        <a href="${SITE}/assembler/" style="display:inline-block;background:#00BFFF;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:1rem;font-weight:700">
          Open Your Dashboard
        </a>
      </div>

      <p style="font-size:0.82rem;color:#71717a;line-height:1.6;margin:0">
        Questions or feedback? Reply to this email or reach us at
        <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.
      </p>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e4e4e7;padding:1rem 2rem;text-align:center">
      <p style="margin:0;font-size:0.75rem;color:#a1a1aa">
        AssembleAtEase &bull; Austin, TX &bull;
        <a href="${SITE}" style="color:#00BFFF;text-decoration:none">assembleatease.com</a>
      </p>
    </div>
  </div>
</div>
</body></html>`;
}

function buildRejectionEmail(firstName, reason, refunded, feeWaived) {
  const refundNote = feeWaived
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:14px 18px;margin-bottom:16px"><p style="margin:0;font-size:0.875rem;color:#1e40af"><strong>No application fee was collected:</strong> Your Founding Easer application was submitted under the launch fee waiver.</p></div>`
    : (refunded
      ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:14px 18px;margin-bottom:16px"><p style="margin:0;font-size:0.875rem;color:#166534"><strong>Refund issued:</strong> Your $30 application fee has been refunded to your original payment method. Please allow 5–10 business days for it to appear.</p></div>`
      : `<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:14px 18px;margin-bottom:16px"><p style="margin:0;font-size:0.875rem;color:#92400e">The application fee policy shown at submission applies.</p></div>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a"><div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;padding:2rem"><img src="${LOGO}" width="36" height="36" style="border-radius:50%;display:block;margin:0 0 1rem"/><p style="font-size:1rem;font-weight:700;margin:0 0 12px">Hi ${esc(firstName)},</p><p style="color:#52525b;line-height:1.7;margin:0 0 16px">Thank you for your interest in AssembleAtEase. After careful review, we are not able to move forward with your application at this time.</p>${reason ? `<div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;padding:14px 18px;margin-bottom:16px"><p style="margin:0;font-size:0.875rem;color:#52525b"><strong>Feedback:</strong> ${esc(reason)}</p></div>` : ''}${refundNote}<p style="color:#52525b;line-height:1.7">You are welcome to reapply after 90 days. Questions? <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a></p></div></div></body></html>`;
}
