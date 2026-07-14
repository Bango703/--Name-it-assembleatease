import { randomUUID } from 'crypto';
import { getSupabase } from '../_supabase.js';
import { sendEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { BOOKING_STATUS, ACTIVE_BOOKING_STATUSES, DISPATCH_OFFER_STATUS, computeBookingSplitFromSnapshot, isBookingPaymentReadyForDispatch } from '../_source-of-truth.js';
import { getEaserReadiness } from '../_easer-readiness.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';
import { logActivity } from './_activity.js';
import { DISPATCH_HISTORY_EXCLUSION_STATUSES } from './_dispatch-safety.js';

const SITE = 'https://www.assembleatease.com';

// ── Constants (override via env) ─────────────────────────────────────────────
const OFFER_TTL_MIN    = parseInt(process.env.DISPATCH_OFFER_TTL_MINUTES  || '20', 10);
const BATCH_SIZE       = parseInt(process.env.DISPATCH_BATCH_SIZE         || '3',  10);
const MAX_ATTEMPTS     = parseInt(process.env.DISPATCH_MAX_ATTEMPTS       || '3',  10);
const MAX_DAILY_JOBS   = parseInt(process.env.DISPATCH_MAX_DAILY_JOBS     || '3',  10);

/**
 * Dispatch a confirmed booking to the best available Easers.
 * Writes per-Easer offer records to dispatch_offers table.
 * Called internally — no HTTP request, no auth check.
 *
 * Returns { dispatched, message, offeredTo, dryRun? }
 */
export async function dispatchBooking(bookingId, { dryRun = false, excludeEaserId = null } = {}) {
  const sb = getSupabase();

  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();
  if (bErr || !booking) return { dispatched: 0, message: 'Booking not found' };
  if (booking.status !== BOOKING_STATUS.CONFIRMED) return { dispatched: 0, message: `Booking not confirmed (status: ${booking.status})` };
  if (!isBookingPaymentReadyForDispatch(booking)) {
    return {
      dispatched: 0,
      message: `Payment is not verified for dispatch (payment status: ${booking.payment_status || 'missing'})`,
      blocked: true,
      code: 'DISPATCH_PAYMENT_NOT_VERIFIED',
    };
  }
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return { dispatched: 0, message: 'Booking locked by a financial operation' };
  }
  if (booking.assembler_id) return { dispatched: 0, message: 'Already assigned' };
  if (booking.dispatch_paused) return { dispatched: 0, message: 'Dispatch paused by owner' };
  if (booking.needs_manual_dispatch) return { dispatched: 0, message: 'Flagged for manual dispatch' };
  if ((booking.dispatch_attempt || 0) >= MAX_ATTEMPTS) {
    return { dispatched: 0, message: `Max dispatch attempts (${MAX_ATTEMPTS}) reached` };
  }

  // Deduplication via dispatch_offers table: check for open (sent) offers
  if (!dryRun) {
    const { data: openOffers, error: openOffersError } = await sb
      .from('dispatch_offers')
      .select('id, expires_at')
      .eq('booking_id', bookingId)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);

    if (openOffersError) {
      console.error('dispatch open-offer lookup error:', openOffersError);
      return { dispatched: 0, message: 'Could not verify current dispatch offers' };
    }

    const stillOpen = (openOffers || []).filter(o => new Date(o.expires_at) > new Date());
    if (stillOpen.length > 0) {
      return { dispatched: 0, message: `${stillOpen.length} offer(s) still open — waiting for Easer response` };
    }
  }

  const bookingCity = extractCity(booking.address || '');
  const bookingZip  = extractZip(booking.address || '');
  const nowMs       = Date.now();

  // ── Easer eligibility query ───────────────────────────────────────────────
  const { data: easers } = await sb
    .from('profiles')
    .select('id, full_name, email, phone, city, zip, status, application_status, tier, rating, completed_jobs, has_membership, is_available, identity_verified, contractor_agreement_signed_at, contractor_agreement_version, code_of_conduct_agreed_at, application_fee_paid, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, account_closure_status, last_assigned_at, acceptance_rate, active_jobs_today, last_dispatch_declined_at, stripe_connect_account_id, stripe_connect_onboarding_complete, stripe_connect_charges_enabled, stripe_connect_payouts_enabled')
    .eq('role', 'assembler')
    .eq('status', 'active')
    .eq('identity_verified', true)
    .in('tier', ['starter', 'professional', 'elite'])
    .or('account_closure_status.is.null,account_closure_status.eq.cancelled')
    .not('phone', 'is', null);

  if (!easers || !easers.length) return { dispatched: 0, message: 'No eligible Easers in system' };

  // ── Filter by canonical readiness and service area ────────────────────────
  // Manual payout mode does not require Connect. When Connect is enabled, the
  // shared readiness predicate verifies the account live and fails closed on
  // requirements or disabled capabilities.
  // Note: MAX_DAILY_JOBS cap is applied below with authoritative booking counts.
  // Do NOT filter on active_jobs_today here — the profile counter can be stale.
  const readinessPairs = await Promise.all(easers.map(async (easer) => ({
    easer,
    readiness: await getEaserReadiness(easer),
  })));
  let eligible = readinessPairs.filter(({ easer, readiness }) => {
    if (!readiness.isReady) return false;
    // When re-dispatching a job a Pro just dropped, don't bounce it straight back
    // to them — it should go to OTHER online Pros (per the drop-and-rematch flow).
    if (excludeEaserId && easer.id === excludeEaserId) return false;
    // No hard city filter. The booking already passed the exact active-ZIP check
    // at creation, and every launch Easer serves the one Central Texas market. City-name matching
    // wrongly excludes Pros whose profile city differs from the booking's (e.g. an
    // "Austin" Pro on a Pflugerville job, or a mistyped city) — which silently chokes
    // dispatch. Proximity is rewarded in scoring (ZIP-match bonus) instead.
    return true;
  }).map(({ easer }) => easer);

  if (!eligible.length) return { dispatched: 0, message: 'No available Easers in service area' };

  // ── Authoritative same-day workload from bookings table ───────────────────
  // Query real active job counts for the booking's scheduled date.
  // This replaces the profile counter (which can drift) and is always accurate.
  // "Active" = booking assigned to this Easer on the same date and not yet done.
  if (booking.date) {
    const { data: sameDayJobs } = await sb
      .from('bookings')
      .select('assembler_id')
      .in('assembler_id', eligible.map(e => e.id))
      .eq('date', booking.date)
      .in('status', ACTIVE_BOOKING_STATUSES);

    const sameDayMap = {};
    (sameDayJobs || []).forEach(b => {
      sameDayMap[b.assembler_id] = (sameDayMap[b.assembler_id] || 0) + 1;
    });

    // Override the stale profile counter with the real-time count
    eligible.forEach(e => { e.active_jobs_today = sameDayMap[e.id] || 0; });

    // Apply the hard daily cap with accurate data
    eligible = eligible.filter(e => e.active_jobs_today < MAX_DAILY_JOBS);
    if (!eligible.length) {
      return { dispatched: 0, message: `All eligible Easers are at the ${MAX_DAILY_JOBS}-job daily limit for ${booking.date}` };
    }
  }

  // Never automatically re-offer the same booking to an Easer who already
  // received it. Repeated declined/expired/cancelled offers confuse Easers and
  // can loop forever without reaching manual dispatch.
  const easerIdsWithOfferHistory = new Set();
  if (!dryRun) {
    const { data: existingOffers, error: existingOffersError } = await sb
      .from('dispatch_offers')
      .select('easer_id')
      .eq('booking_id', bookingId)
      .in('offer_status', DISPATCH_HISTORY_EXCLUSION_STATUSES);
    if (existingOffersError) {
      console.error('dispatch offer-history lookup error:', existingOffersError);
      return { dispatched: 0, message: 'Could not verify prior dispatch recipients' };
    }
    (existingOffers || []).forEach(o => easerIdsWithOfferHistory.add(o.easer_id));
  }

  const scoreable = eligible.filter(e => !easerIdsWithOfferHistory.has(e.id));
  if (!scoreable.length) return { dispatched: 0, message: 'All eligible Easers already received offers' };

  // ── Enhanced scoring ──────────────────────────────────────────────────────
  const isHighValue = (booking.total_price || 0) > 20000; // > $200

  const scored = scoreable.map(e => {
    let score = e.tier === 'elite' ? 400 : e.tier === 'professional' ? 250 : 100;

    // High-value job: penalize starter Easers
    if (isHighValue && e.tier === 'starter') score -= 100;

    if (hasEffectiveEaserMembership(e)) score += 150;
    if (bookingZip && e.zip && e.zip === bookingZip) score += 75;

    // Rating bonus (0–75)
    if (e.rating) score += Math.round(Number(e.rating) * 15);

    // Experience bonus (0–50)
    score += Math.min(50, (e.completed_jobs || 0) * 2);

    // Fairness: hours since last assignment (0–30)
    if (e.last_assigned_at) {
      const hrs = (nowMs - new Date(e.last_assigned_at).getTime()) / 3600000;
      score += Math.min(30, Math.round(hrs));
    } else {
      score += 30; // Never assigned: maximum fairness bonus
    }

    // Acceptance rate bonus (0–50)
    if (e.acceptance_rate != null) {
      score += Math.round(Number(e.acceptance_rate) * 0.5);
    }

    // Overload penalty: already has jobs today
    const jobsToday = e.active_jobs_today || 0;
    if (jobsToday > 1) score -= (jobsToday - 1) * 50;

    // Recent decline penalty: declined within last 2 hours → -200
    if (e.last_dispatch_declined_at) {
      const hrsSince = (nowMs - new Date(e.last_dispatch_declined_at).getTime()) / 3600000;
      if (hrsSince < 2) score -= 200;
    }

    return { ...e, _score: Math.max(0, score) };
  }).sort((a, b) => b._score - a._score);

  const top = scored.slice(0, BATCH_SIZE);

  if (dryRun) {
    return {
      dispatched: 0,
      dryRun: true,
      message: `Dry run — would offer to ${top.length} Easer(s)`,
      offeredTo: top.map(e => ({
        id: e.id,
        name: e.full_name,
        tier: e.tier,
        score: e._score,
        email: e.email,
        rating: e.rating,
        city: e.city,
      })),
    };
  }

  // ── Write offer records (one per Easer) ──────────────────────────────────
  const attemptNumber = (booking.dispatch_attempt || 0) + 1;
  const expiresAt = new Date(nowMs + OFFER_TTL_MIN * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const offerRecords = top.map(e => ({
    booking_id: bookingId,
    easer_id: e.id,
    dispatch_score: e._score,
    token: randomUUID(),
    attempt_number: attemptNumber,
    expires_at: expiresAt,
    notification_sent: false,
  }));

  const { data: insertedOffers, error: offerErr } = await sb
    .from('dispatch_offers')
    .insert(offerRecords)
    .select('id, easer_id, token');

  if (offerErr) {
    console.error('dispatch_offers insert error:', offerErr);
    return {
      dispatched: 0,
      message: offerErr.code === '23505'
        ? 'Another dispatch request already created active offers'
        : 'Failed to create offer records',
    };
  }

  // Build token map: easer_id → token
  const tokenByEaser = {};
  (insertedOffers || []).forEach(o => { tokenByEaser[o.easer_id] = o.token; });

  // ── Atomic booking update ────────────────────────────────────────────────
  // Single update — atomic guard: only proceed if still unassigned
  let bookingUpdateQuery = sb.from('bookings').update({
    dispatch_attempt:    attemptNumber,
    dispatch_offered_at: now,
    dispatch_status:     'offered',
    dispatch_offered_to: top.map(e => e.id), // keep for backwards compat
    needs_manual_dispatch: false,             // clear manual flag on retry
  })
    .eq('id', bookingId)
    .is('assembler_id', null)
    .eq('status', BOOKING_STATUS.CONFIRMED)
    .eq('payment_status', booking.payment_status)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);

  bookingUpdateQuery = booking.total_price == null
    ? bookingUpdateQuery.is('total_price', null)
    : bookingUpdateQuery.eq('total_price', booking.total_price);
  bookingUpdateQuery = booking.stripe_payment_intent_id == null
    ? bookingUpdateQuery.is('stripe_payment_intent_id', null)
    : bookingUpdateQuery.eq('stripe_payment_intent_id', booking.stripe_payment_intent_id);
  bookingUpdateQuery = booking.stripe_deposit_intent_id == null
    ? bookingUpdateQuery.is('stripe_deposit_intent_id', null)
    : bookingUpdateQuery.eq('stripe_deposit_intent_id', booking.stripe_deposit_intent_id);

  bookingUpdateQuery = booking.dispatch_paused == null
    ? bookingUpdateQuery.is('dispatch_paused', null)
    : bookingUpdateQuery.eq('dispatch_paused', false);
  bookingUpdateQuery = booking.needs_manual_dispatch == null
    ? bookingUpdateQuery.is('needs_manual_dispatch', null)
    : bookingUpdateQuery.eq('needs_manual_dispatch', false);

  // Serialize competing dispatch rounds against the exact attempt snapshot
  // read above. Only one request can advance the attempt counter.
  bookingUpdateQuery = booking.dispatch_attempt == null
    ? bookingUpdateQuery.is('dispatch_attempt', null)
    : bookingUpdateQuery.eq('dispatch_attempt', booking.dispatch_attempt);

  const { data: updatedBookings, error: bookingUpdateErr } = await bookingUpdateQuery.select('id');

  if (bookingUpdateErr || !updatedBookings?.length) {
    // Booking was just assigned — cancel the offers we just created
    await sb.from('dispatch_offers')
      .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
      .eq('booking_id', bookingId)
      .in('id', (insertedOffers || []).map(o => o.id));
    return { dispatched: 0, message: 'Booking assigned while dispatching — offers cancelled' };
  }

  // ── Send notifications (non-blocking) ────────────────────────────────────
  let notified = 0;
  const notificationFailures = [];
  for (const easer of top) {
    // Notifications/emails OPEN the offer in the app — they NEVER accept it. A job
    // is accepted only when the Easer taps Accept inside the app (source of truth).
    const offerUrl = `${SITE}/assembler/my-assignments?offer=${bookingId}`;

    // Show net pay in the push too, so a Pro isn't blind. AssembleCash is funded
    // by the platform margin, so reward use must not shrink the Easer estimate.
    const estPayCents = booking.total_price > 0
      ? computeBookingSplitFromSnapshot({
          totalPriceCents: booking.total_price,
          taxCents: booking.tax_amount || 0,
          isMember: hasEffectiveEaserMembership(easer),
          assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
        }).assemblerDueCents
      : 0;
    const pushPay = estPayCents > 0
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(estPayCents / 100) + ' estimated earnings · '
      : '';
    const pushResult = await sendPushToUser(easer.id, {
      title: 'New Job Available',
      body:  `${booking.service || 'Service'} · ${pushPay}${booking.date || ''}${booking.time ? ' at ' + booking.time : ''} · Tap to review`,
      url:   offerUrl,
      jobId: bookingId,
      urgent: true,
    }, { bookingId, notificationType: 'dispatch_offer', recipientType: 'easer' }).catch(function(err) {
      console.error('[dispatch] Push failed for easer', easer.id, err && (err.message || String(err)));
      return { ok: false, error: err?.message || String(err) };
    });

    let emailResult = { ok: false, error: 'Missing Easer email' };
    try {
      emailResult = await sendEmail({
        to:       easer.email,
        from:     'AssembleAtEase <booking@assembleatease.com>',
        subject:  `New Job Available — ${booking.service || 'Service'} in ${bookingCity}`,
        html:     buildOfferEmail(easer, booking, bookingCity, offerUrl, expiresAt),
        replyTo:  'service@assembleatease.com',
        meta:     { bookingId, notificationType: 'dispatch_offer', recipientType: 'easer', recipientUserId: easer.id },
      });
    } catch (err) {
      console.error('Dispatch email error:', easer.email, err.message);
      emailResult = { ok: false, error: err.message };
    }

    const delivered = Boolean(
      (emailResult?.ok && !emailResult?.suppressed)
      || pushResult?.ok
    );
    if (emailResult?.logged === false || pushResult?.logged === false) {
      await logActivity(sb, {
        bookingId,
        eventType: 'notification_audit_failed',
        actorType: 'system',
        actorName: 'notifications',
        description: `Job offer notification was attempted for ${easer.full_name || 'Easer'}, but an attempt log could not be saved`,
        metadata: { easerId: easer.id, emailLogError: emailResult?.logError || null, pushLogError: pushResult?.logError || null },
      });
    }
    if (delivered) {
      const { error: sentStateErr } = await sb.from('dispatch_offers')
        .update({ notification_sent: true })
        .eq('booking_id', bookingId)
        .eq('easer_id', easer.id)
        .eq('attempt_number', attemptNumber);
      if (!sentStateErr) notified++;
    } else {
      notificationFailures.push({
        easerId: easer.id,
        easerName: easer.full_name,
        email: easer.email || null,
        emailError: emailResult?.error || emailResult?.reason || null,
        pushError: pushResult?.error || pushResult?.reason || null,
      });
      await logActivity(sb, {
        bookingId,
        eventType: 'dispatch_notification_failed',
        actorType: 'system',
        actorName: 'dispatch',
        description: `Job offer created for ${easer.full_name || 'Easer'}, but no notification channel confirmed delivery`,
        metadata: { easerId: easer.id, email: easer.email || null, attemptNumber },
      });
    }
  }

  await logActivity(sb, {
    bookingId,
    eventType: 'dispatched',
    actorType: 'system',
    actorName: 'dispatch',
    description: `Created ${top.length} job offer(s); ${notified} had a channel-confirmed notification`,
    metadata: {
      attemptNumber,
      expiresAt,
      offeredEaserIds: top.map(easer => easer.id),
      notified,
      failedNotificationCount: notificationFailures.length,
    },
  });

  console.log(JSON.stringify({
    event: 'dispatch',
    bookingId,
    attempt: attemptNumber,
    offered: top.length,
    notified,
    expiry: expiresAt,
    easers: top.map(e => ({ id: e.id, name: e.full_name, score: e._score, tier: e.tier })),
  }));

  return {
    dispatched: top.length,
    notified,
    message: notified > 0
      ? `Created ${top.length} offer(s); notified ${notified} Easer(s) — expires in ${OFFER_TTL_MIN} min`
      : `Created ${top.length} offer(s), but no notification channel confirmed delivery`,
    offeredTo: top.map(e => ({
      name: e.full_name,
      tier: e.tier,
      score: e._score,
      token: tokenByEaser[e.id],
    })),
    attemptNumber,
    expiresAt,
    notificationFailures,
  };
}

// ── Address helpers ───────────────────────────────────────────────────────────
function extractCity(address) {
  if (!address) return '';
  // Format A: "Street, City ST ZIP" — city embedded in last segment before state+zip
  const m = address.match(/,\s*([A-Za-z][A-Za-z\s]+?)\s+[A-Z]{2}\s+\d{5}/);
  if (m) return m[1].trim();
  // Format B: "Street, City, ST ZIP" — city is second-to-last comma segment
  const parts = address.split(',');
  if (parts.length >= 3) return parts[parts.length - 2].trim();
  // No city parseable — return empty so city filter is skipped (not defaulted)
  return '';
}

function extractZip(address) {
  const m = address.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

// ── Offer email ───────────────────────────────────────────────────────────────
function buildOfferEmail(easer, booking, city, offerUrl, expiresAt) {
  const firstName   = (easer.full_name || 'there').split(' ')[0];
  // Net take-home from the canonical split. AssembleCash is platform-funded, so
  // the offer must not look smaller just because the customer used a reward.
  const split = computeBookingSplitFromSnapshot({
    totalPriceCents: booking.total_price || 0,
    taxCents: booking.tax_amount || 0,
    isMember: hasEffectiveEaserMembership(easer),
    assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
  });
  const payEstimate = booking.total_price > 0
    ? '$' + Math.round(split.assemblerDueCents / 100).toLocaleString()
    : 'Custom quote — price set by owner after review';
  const expiryMin   = Math.round((new Date(expiresAt) - Date.now()) / 60000);
  const tierLabel   = { starter: 'Starter', professional: 'Professional', elite: 'Elite' }[easer.tier] || easer.tier;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:linear-gradient(135deg,#003d47,#00BFFF);padding:1.5rem;text-align:center">
      <p style="margin:0 0 4px;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.7)">${esc(tierLabel)} Easer</p>
      <h2 style="margin:0;color:#fff;font-size:1.25rem;font-weight:700">New Job Available</h2>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:0.85rem">Hi ${esc(firstName)} — first to accept gets the job</p>
    </div>
    <div style="padding:1.5rem">
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:1.1rem;margin-bottom:1.25rem">
        <p style="margin:0 0 8px;font-size:1.05rem;font-weight:700;color:#111">${esc(booking.service)}</p>
        <p style="margin:0 0 4px;font-size:0.875rem;color:#374151">Location: ${esc(city)}</p>
        <p style="margin:0 0 4px;font-size:0.875rem;color:#374151">Date: ${esc(booking.date || 'TBD')}${booking.time ? ' · ' + esc(booking.time) : ''}</p>
        <p style="margin:8px 0 0;font-size:0.95rem;font-weight:${booking.total_price > 0 ? '700' : '500'};color:#00BFFF">Est. pay: ${payEstimate}</p>
      </div>
      <div style="background:#fef9ec;border:1px solid #fbbf24;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.25rem">
        <span style="font-size:0.85rem;color:#92400e;font-weight:600">Offer expires in about ${expiryMin} minutes</span>
      </div>
      <a href="${esc(offerUrl)}" style="display:block;text-align:center;background:#00BFFF;color:#fff;padding:14px 20px;border-radius:8px;text-decoration:none;font-size:0.95rem;font-weight:700">View Job &amp; Respond →</a>
      <p style="margin:10px 0 0;text-align:center;font-size:11px;color:#9ca3af">Opens your dashboard — review the details and tap Accept there.</p>
    </div>
    <div style="padding:0.875rem 1.5rem;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af">
      View all your assignments at <a href="${SITE}/assembler/my-assignments" style="color:#00BFFF">AssembleAtEase</a>
    </div>
  </div>
</div></body></html>`;
}
