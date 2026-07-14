import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logCron } from './_cron-logger.js';
import { releasePendingRedemption } from '../_assemblecash.js';
import { logActivity } from '../booking/_activity.js';
import {
  classifyPendingExpiry,
  isRecoverablePaymentIntentStatus,
  validateBookingPaymentIntent,
} from '../booking/_pending-payment-recovery.js';
import {
  releaseBookingFinancialOperation,
  reserveBookingFinancialOperation,
} from '../booking/_financial-operation.js';

const STALE_DAYS = 7;       // auto-decline bookings still pending after 7 days
const ACCEPT_HOURS = 24;    // auto-cancel assigned bookings not accepted within 24 hours

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
  const sb = getSupabase();

  // ── 1. Cancel confirmed bookings where assembler has not accepted within 24 hours ──
  const acceptCutoff = new Date(Date.now() - ACCEPT_HOURS * 3600000).toISOString();
  const { data: unaccepted, error: unacceptedError } = await sb
    .from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .is('assembler_accepted_at', null)
    .lt('assigned_at', acceptCutoff)
    .limit(20);
  if (unacceptedError) {
    console.error('Stale-booking unaccepted lookup error:', unacceptedError);
    await logCron('stale-booking', { status: 'error', error: unacceptedError.message, duration: Date.now() - t });
    return res.status(500).json({ error: 'Unaccepted booking lookup failed' });
  }

  let autoRequeued = 0;
  let requeueFailures = 0;
  for (const b of unaccepted || []) {
    try {
      // Keep the customer booking confirmed while removing the stale assignment.
      let requeueQuery = sb.from('bookings').update({
        status: 'confirmed',
        pipeline_stage: 'confirmed',
        assembler_id: null,
        assembler_name: null,
        assembler_tier: null,
        assembler_accepted_at: null,
        assigned_at: null,
        assignment_token: null,
        dispatch_token: null,
        dispatch_status: 'manual_required',
        needs_manual_dispatch: true,
        dispatch_paused: true,
        decline_reason: null,
        declined_at: null,
        easer_fee_snapshot_easer_id: null,
        easer_fee_pct_snapshot: null,
        easer_estimated_due_snapshot: null,
        easer_fee_snapshot_at: null,
      })
        .eq('id', b.id)
        .eq('status', 'confirmed')
        .eq('assigned_at', b.assigned_at)
        .is('assembler_accepted_at', null)
        .is('financial_operation_key', null)
        .is('financial_operation_type', null);
      requeueQuery = b.assembler_id
        ? requeueQuery.eq('assembler_id', b.assembler_id)
        : requeueQuery.is('assembler_id', null);
      requeueQuery = b.assignment_token
        ? requeueQuery.eq('assignment_token', b.assignment_token)
        : requeueQuery.is('assignment_token', null);
      const { data: requeuedRows, error: requeueError } = await requeueQuery.select('id');
      if (requeueError) {
        requeueFailures++;
        console.error(`Auto-requeue update failed for ${b.ref}:`, requeueError);
        continue;
      }
      if (!requeuedRows?.length) {
        console.warn(`Auto-requeue skipped for ${b.ref}: booking state changed.`);
        continue;
      }

      const activityResult = await logActivity(sb, {
        bookingId: b.id,
        eventType: 'dispatch_manual_required',
        actorType: 'system',
        actorName: 'stale-booking',
        description: `${b.ref} requires manual reassignment after the Easer did not accept within ${ACCEPT_HOURS} hours`,
        metadata: { previousEaserId: b.assembler_id || null, assignedAt: b.assigned_at || null },
      });
      if (!activityResult.ok) console.error(`Auto-requeue timeline failed for ${b.ref}:`, activityResult.error);

      // Notify owner to reassign
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase System <booking@assembleatease.com>',
        subject: `Action Required: Booking ${b.ref} needs reassignment`,
        html: `<p>Booking <strong>${esc(b.ref)}</strong> (${esc(b.service)} for ${esc(b.customer_name)}) was not accepted by the assigned assembler within 24 hours.</p>
<p>The customer booking remains confirmed and is now flagged for manual reassignment. Please log in and assign a replacement as soon as possible.</p>
<p>Job date: <strong>${esc(b.date)}</strong> at ${esc(b.time)}</p>`,
        replyTo: ownerEmail(),
      });

      // Reassure customer there is no disruption
      await sendEmail({
        to: b.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Update on your booking — ${esc(b.ref)}`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 8px;font-size:18px;font-weight:700">Hi ${esc((b.customer_name||'').split(' ')[0])},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">We're making a quick adjustment to your upcoming booking (<strong>${esc(b.ref)}</strong>) and are assigning you a new assembler. Your appointment date and time remain unchanged.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#166534;line-height:1.6">
      Your booking remains secure and confirmed.<br/>You will receive an updated Easer confirmation after reassignment.<br/>Your existing payment authorization has not changed; capture occurs only after completion.
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a">Questions? Reply to this email or call us at 737-290-6129.</p>
  </td></tr></table>
</div></body></html>`,
        replyTo: ownerEmail(),
      });

      autoRequeued++;
    } catch (err) {
      console.error('Auto-requeue error for ' + b.ref + ':', err);
    }
  }

  // ── 2. Expire pending requests only after their exact payment state is safe ──
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  const [staleCreatedRes, expiredQuoteRes] = await Promise.all([
    sb.from('bookings').select('*')
      .eq('status', 'pending')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(50),
    sb.from('bookings').select('*')
      .eq('status', 'pending')
      .in('payment_status', ['quote_pending_approval', 'quote_authorization_pending'])
      .lte('quote_expires_at', nowIso)
      .order('quote_expires_at', { ascending: true })
      .limit(50),
  ]);

  if (staleCreatedRes.error || expiredQuoteRes.error) {
    const queryError = staleCreatedRes.error || expiredQuoteRes.error;
    console.error('Stale booking cron error:', queryError);
    await logCron('stale-booking', { status: 'error', error: queryError.message, duration: Date.now() - t });
    return res.status(500).json({ error: 'Query failed' });
  }

  const bookingMap = new Map();
  [...(staleCreatedRes.data || []), ...(expiredQuoteRes.data || [])]
    .forEach(booking => bookingMap.set(booking.id, booking));
  const bookings = [...bookingMap.values()]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (!bookings || !bookings.length) {
    await logCron('stale-booking', {
      status: requeueFailures ? 'error' : 'ok',
      records: autoRequeued,
      error: requeueFailures ? `${requeueFailures} auto-requeue update(s) failed` : null,
      duration: Date.now() - t,
    });
    if (requeueFailures) {
      return res.status(500).json({ error: 'Some unaccepted bookings could not be requeued', declined: 0, autoRequeued, requeueFailures });
    }
    return res.status(200).json({ declined: 0, autoRequeued, requeueFailures: 0, message: 'No stale bookings' });
  }

  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  let declined = 0;
  const declinedBookings = [];
  const reconciliationIssues = [];

  for (const b of bookings) {
    const expiry = classifyPendingExpiry(b, {
      nowMs: Date.now(),
      staleBeforeMs: Date.parse(cutoff),
    });
    if (!expiry.eligible) {
      if (expiry.requiresReconciliation) reconciliationIssues.push({ booking: b, reason: expiry.reason });
      continue;
    }
    const operationKey = `expire:pending:${b.id}`;
    try {
      try {
        await reserveBookingFinancialOperation(sb, {
          bookingId: b.id,
          operationKey,
          operationType: 'expire_payment',
          expectedStatuses: ['pending'],
          expectedAssemblerId: b.assembler_id ?? null,
          expectedBooking: b,
        });
      } catch (reservationError) {
        reconciliationIssues.push({ booking: b, reason: reservationError.code || 'expiry_reservation_failed' });
        continue;
      }

      const externalState = await prepareExternalPaymentForExpiry({ booking: b, expiry, stripe });
      if (!externalState.ok) {
        reconciliationIssues.push({ booking: b, reason: externalState.reason, stripeStatus: externalState.stripeStatus || null });
        if (externalState.mutationAmbiguous) {
          await holdExpiryForReconciliation(sb, b, operationKey, externalState.reason);
        } else {
          try {
            const released = await releaseBookingFinancialOperation(sb, { bookingId: b.id, operationKey });
            if (!released) {
              await holdExpiryForReconciliation(sb, b, operationKey, 'The pending-payment expiration lock could not be released after Stripe remained unchanged.');
            } else {
              await sb.from('bookings').update({
                financial_reconciliation_required_at: null,
                financial_reconciliation_reason: null,
              })
                .eq('id', b.id)
                .is('financial_operation_key', null)
                .is('financial_operation_type', null);
            }
          } catch (error) {
            console.error(`Stale expiry lock release failed for ${b.ref}:`, error);
            await holdExpiryForReconciliation(sb, b, operationKey, 'The pending-payment expiration lock could not be released after Stripe remained unchanged.');
          }
        }
        await logActivity(sb, {
          bookingId: b.id,
          eventType: 'pending_expiry_reconciliation_required',
          actorType: 'system',
          actorName: 'stale-booking',
          description: `Pending request was not expired because payment state needs reconciliation (${externalState.reason}).`,
          metadata: { paymentStatus: b.payment_status, stripeStatus: externalState.stripeStatus || null },
        });
        continue;
      }

      const declineReason = expiry.kind === 'quote'
        ? 'Quote expired without customer approval'
        : expiry.kind === 'quote_request'
          ? 'Quote request expired before pricing was completed'
          : expiry.kind === 'standard_payment'
            ? `Card authorization was not completed within ${STALE_DAYS} days`
            : `Request expired after ${STALE_DAYS} days without confirmation`;
      const nextPaymentStatus = expiry.kind === 'no_payment_request' ? b.payment_status : 'failed';
      let declineQuery = sb.from('bookings')
        .update({
          status: 'declined',
          payment_status: nextPaymentStatus,
          declined_at: new Date().toISOString(),
          decline_reason: declineReason,
          quote_token_hash: null,
          financial_operation_key: null,
          financial_operation_type: null,
          financial_operation_started_at: null,
          financial_reconciliation_required_at: null,
          financial_reconciliation_reason: null,
        })
        .eq('id', b.id)
        .eq('status', 'pending')
        .eq('payment_status', b.payment_status)
        .eq('created_at', b.created_at)
        .eq('financial_operation_key', operationKey)
        .eq('financial_operation_type', 'expire_payment');
      declineQuery = b.stripe_payment_intent_id
        ? declineQuery.eq('stripe_payment_intent_id', b.stripe_payment_intent_id)
        : declineQuery.is('stripe_payment_intent_id', null);
      declineQuery = b.quote_token_hash
        ? declineQuery.eq('quote_token_hash', b.quote_token_hash)
        : declineQuery.is('quote_token_hash', null);
      const { data: declinedRows, error: declineError } = await declineQuery.select('id');
      if (declineError) {
        reconciliationIssues.push({ booking: b, reason: 'database_expiry_failed' });
        console.error(`Stale decline update failed for ${b.ref}:`, declineError);
        await holdExpiryForReconciliation(sb, b, operationKey, 'Stripe was cleared, but the expired booking state could not be saved. The stale-booking job will retry this exact reservation.');
        continue;
      }
      if (!declinedRows?.length) {
        console.warn(`Stale decline skipped for ${b.ref}: booking state changed.`);
        reconciliationIssues.push({ booking: b, reason: 'database_expiry_state_changed' });
        await holdExpiryForReconciliation(sb, b, operationKey, 'Stripe was cleared, but booking state changed before expiration could be saved. Review the timeline before releasing this hold.');
        continue;
      }
      await releasePendingRedemption(sb, {
        bookingId: b.id,
        bookingRef: b.ref,
        customerEmail: b.customer_email,
        reason: 'reverse:stale_pending_declined',
      });
      await logActivity(sb, {
        bookingId: b.id,
        eventType: expiry.kind === 'quote' ? 'quote_expired' : 'pending_payment_expired',
        actorType: 'system',
        actorName: 'stale-booking',
        description: declineReason,
        metadata: { priorPaymentStatus: b.payment_status, stripeStatus: externalState.stripeStatus || null },
      });

      // Notify customer
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Booking Update</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">Hi ${esc(b.customer_name)}, your ${expiry.kind === 'quote' ? 'quote' : 'booking request'} <strong>${esc(b.ref)}</strong> for <strong>${esc(b.service)}</strong> expired before it was confirmed.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6">If you'd still like to schedule this service, please submit a new booking request and we'll get back to you promptly.</p>
    </td></tr></table>
    <table cellpadding="0" cellspacing="0" style="margin:20px 0 0"><tr><td style="background:#1d9e75;border-radius:8px;padding:0"><a href="https://www.assembleatease.com" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px">Book Again</a></td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;

      await sendEmail({
        to: b.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Booking ' + b.ref + ' - request expired',
        html,
        replyTo: ownerEmail(),
        meta: { bookingId: b.id, notificationType: expiry.kind === 'quote' ? 'quote_expired' : 'payment_expired', recipientType: 'customer' },
      }).catch(error => console.error(`Stale booking customer email failed for ${b.ref}:`, error?.message || error));

      declined++;
      declinedBookings.push(b);
    } catch (err) {
      reconciliationIssues.push({ booking: b, reason: err?.message || 'unexpected_expiry_error' });
      console.error('Stale booking error for ' + b.ref + ':', err);
    }
  }

  // Notify owner summary
  if (declined > 0) {
    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase System <booking@assembleatease.com>',
        subject: 'Expired ' + declined + ' stale pending request(s)',
        html: '<p>' + declined + ' pending request(s) were expired only after external payment state was cleared or verified absent.</p><p>Refs: ' + declinedBookings.map(function(b){return esc(b.ref)}).join(', ') + '</p>',
        replyTo: ownerEmail(),
        meta: { notificationType: 'stale_booking_summary', recipientType: 'owner' },
      });
    } catch (e) {
      console.error('Owner notification error:', e);
    }
  }

  if (reconciliationIssues.length > 0) {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase System <booking@assembleatease.com>',
      subject: `Action required - ${reconciliationIssues.length} pending payment state(s) need review`,
      html: `<p>The stale-booking job left these records unchanged because Stripe or database truth was not safe to expire:</p><ul>${reconciliationIssues.map(issue => `<li><strong>${esc(issue.booking.ref)}</strong>: ${esc(issue.reason)}${issue.stripeStatus ? ` (${esc(issue.stripeStatus)})` : ''}</li>`).join('')}</ul><p>Review Stripe and the booking timeline before changing status.</p>`,
      replyTo: ownerEmail(),
      meta: { notificationType: 'stale_payment_reconciliation', recipientType: 'owner' },
    }).catch(error => console.error('Owner reconciliation email failed:', error?.message || error));
  }

  const cronFailed = requeueFailures > 0 || reconciliationIssues.length > 0;
  const cronError = [
    requeueFailures ? `${requeueFailures} auto-requeue update(s) failed` : null,
    reconciliationIssues.length ? `${reconciliationIssues.length} pending payment state(s) require reconciliation` : null,
  ].filter(Boolean).join('; ') || null;
  await logCron('stale-booking', {
    status: cronFailed ? 'error' : 'ok',
    records: declined + autoRequeued,
    error: cronError,
    duration: Date.now() - t,
  });
  if (cronFailed) {
    return res.status(500).json({
      error: cronError,
      declined,
      total: bookings.length,
      autoRequeued,
      requeueFailures,
      reconciliationRequired: reconciliationIssues.length,
    });
  }
  return res.status(200).json({ declined, total: bookings.length, autoRequeued, requeueFailures: 0, reconciliationRequired: 0 });
}

async function holdExpiryForReconciliation(sb, booking, operationKey, reason) {
  const { data, error } = await sb.from('bookings').update({
    financial_reconciliation_required_at: new Date().toISOString(),
    financial_reconciliation_reason: String(reason || 'Pending-payment expiration requires reconciliation.'),
  })
    .eq('id', booking.id)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', 'expire_payment')
    .select('id');
  if (error || !data?.length) {
    console.error(`Stale expiry reconciliation marker failed for ${booking.ref}:`, error || 'state changed');
    return false;
  }
  return true;
}

async function prepareExternalPaymentForExpiry({ booking, expiry, stripe }) {
  if (!booking.stripe_payment_intent_id) {
    if (booking.payment_status === 'quote_authorization_pending') {
      return { ok: false, reason: 'quote_authorization_missing_payment_intent', mutationAmbiguous: false };
    }
    return { ok: true, stripeStatus: null, mutationConfirmed: false };
  }
  if (!stripe) return { ok: false, reason: 'stripe_not_configured', mutationAmbiguous: false };

  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  } catch (error) {
    return { ok: false, reason: 'stripe_lookup_failed', detail: error?.message || String(error), mutationAmbiguous: false };
  }

  const quotePayment = expiry.kind === 'quote';
  const validation = validateBookingPaymentIntent(booking, intent, {
    type: quotePayment ? 'customer_quote' : 'customer_booking',
    amountCents: quotePayment ? booking.quote_amount_cents : booking.total_price,
  });
  if (quotePayment && intent.metadata?.quoteTermsVersion !== booking.quote_terms_version) {
    validation.ok = false;
    validation.errors.push('quote_terms_version');
  }
  const expectedLiveMode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_')
    ? true
    : (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? false : null);
  const intentCustomerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id || null;
  if (booking.stripe_customer_id && intentCustomerId !== booking.stripe_customer_id
      && !validation.errors.includes('stripe_customer_id')) {
    validation.ok = false;
    validation.errors.push('stripe_customer_id');
  }
  if (expectedLiveMode != null && intent.livemode !== expectedLiveMode
      && !validation.errors.includes('livemode')) {
    validation.ok = false;
    validation.errors.push('livemode');
  }
  if (!validation.ok) {
    return { ok: false, reason: `stripe_mismatch:${validation.errors.join(',')}`, stripeStatus: intent.status, mutationAmbiguous: false };
  }
  if (intent.status === 'requires_capture') {
    return { ok: false, reason: 'authorization_requires_confirmation_reconciliation', stripeStatus: intent.status, mutationAmbiguous: false };
  }
  if (intent.status === 'canceled') return { ok: true, stripeStatus: intent.status, mutationConfirmed: false };
  if (!isRecoverablePaymentIntentStatus(intent.status)) {
    return { ok: false, reason: 'stripe_state_not_expirable', stripeStatus: intent.status, mutationAmbiguous: false };
  }

  try {
    const cancelled = await stripe.paymentIntents.cancel(intent.id);
    if (cancelled.status !== 'canceled') {
      return { ok: false, reason: 'stripe_cancel_not_confirmed', stripeStatus: cancelled.status, mutationAmbiguous: true };
    }
    return { ok: true, stripeStatus: cancelled.status, mutationConfirmed: true };
  } catch (error) {
    try {
      const afterError = await stripe.paymentIntents.retrieve(intent.id);
      if (afterError.status === 'canceled') {
        return { ok: true, stripeStatus: afterError.status, mutationConfirmed: true, recoveredAfterError: true };
      }
      return {
        ok: false,
        reason: 'stripe_cancel_failed_but_intent_remains_open',
        stripeStatus: afterError.status,
        detail: error?.message || String(error),
        mutationAmbiguous: false,
      };
    } catch (verificationError) {
      return {
        ok: false,
        reason: 'stripe_cancel_outcome_unknown',
        stripeStatus: intent.status,
        detail: verificationError?.message || error?.message || String(error),
        mutationAmbiguous: true,
      };
    }
  }
}
