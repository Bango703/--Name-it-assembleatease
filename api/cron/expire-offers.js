import { getSupabase } from '../_supabase.js';
import { finalizeDispatchRound, holdDispatchForPaymentReconciliation, notifyOwnerManualDispatch } from '../booking/_dispatch-safety.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { logCron } from './_cron-logger.js';
import { recordUnansweredOffers, setOfflineIfUnanswered } from '../_easer-reliability.js';
import { EASER_RELIABILITY_POLICY } from '../_source-of-truth.js';
import { sendEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { sendSms } from '../_sms.js';
import { notifyOwnerOfOnlineEasers } from '../_easer-go-online.js';

const MAX_ATTEMPTS = parseInt(process.env.DISPATCH_MAX_ATTEMPTS || '3', 10);

/**
 * GET /api/cron/expire-offers
 * Runs every 10 minutes via Vercel cron.
 * 1. Expires stale 'sent' offers past their expiry time.
 * 2. For bookings where ALL offers are now resolved (expired/declined):
 *    - If under max attempts: trigger next dispatch round
 *    - If at max attempts: flag needs_manual_dispatch, alert owner
 */
export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const now = new Date().toISOString();
  const results = { expired: 0, retried: [], renewed: [], paymentHeld: [], flagged: [], errors: [] };

  // KEEP OFFERS OPEN WHEN THERE IS NOBODY ELSE TO ASK.
  //
  // The retry ladder is right when there are more Easers: an unanswered offer
  // expires and the job widens to the next batch. But once every eligible Easer
  // already has it, expiring achieves nothing — the job leaves their queue,
  // lands back on the owner as "needs manual dispatch", and the only people who
  // could ever take it can no longer see it. On a small roster that is the
  // normal case, not the edge case.
  //
  // When enabled, the offer is RENEWED instead: it stays live in the Easer's app
  // until someone accepts, declines, or the owner intervenes. Declined offers
  // are never renewed — a no is a no. The owner still sees the booking as
  // awaiting acceptance through the existing Live Ops alerts, so nothing goes
  // quiet; it simply stops being handed back with nowhere to go.
  const KEEP_OFFERS_OPEN = String(process.env.DISPATCH_KEEP_OFFERS_OPEN || 'true').toLowerCase() !== 'false';
  const RENEW_MINUTES = parseInt(process.env.DISPATCH_OFFER_TTL_MINUTES || '20', 10);

  // ── Step 1: Expire stale offers ────────────────────────────────────────────
  const { data: expiredOffers, error: expireErr } = await sb
    .from('dispatch_offers')
    .update({ offer_status: 'expired', timed_out_at: now })
    .eq('offer_status', 'sent')
    .lt('expires_at', now)
    .select('id, booking_id, easer_id');

  if (expireErr) {
    console.error('expire-offers: expire error', expireErr);
    results.errors.push('expire step: ' + expireErr.message);
  } else {
    results.expired = (expiredOffers || []).length;
  }

  // ── Step 1b: an Easer online who lets offers expire goes offline ───────────
  // Owner, 2026-10-28: "lets offers expire repeatedly" and "keeps themselves
  // available but ignores everything". Not a strike; they come back online
  // whenever they are ready. Never blocks the dispatch work below.
  results.setOffline = [];
  try {
    const easerIds = await recordUnansweredOffers(sb, expiredOffers || []);
    for (const easerId of easerIds) {
      const outcome = await setOfflineIfUnanswered(sb, easerId);
      if (outcome.offline) {
        results.setOffline.push(easerId);
        await notifyEaserSetOffline(sb, easerId, outcome.streak);
      }
    }
  } catch (err) {
    console.error('expire-offers: unanswered-offer check failed', err?.message || err);
    results.errors.push('unanswered check: ' + (err?.message || String(err)));
  }

  // ── Step 1c: an Easer the owner asked to go online came online ─────────────
  // Going online is the Easer's own profile write, so there is no request to
  // hook; this check tells the owner once per request (api/_easer-go-online.js).
  try {
    results.askedOnline = (await notifyOwnerOfOnlineEasers(sb)).told;
  } catch (err) {
    console.error('expire-offers: go-online check failed', err?.message || err);
    results.errors.push('go-online check: ' + (err?.message || String(err)));
  }

  // ── Step 2: Find bookings whose round may now be resolved ──────────────────
  // Include the normal just-expired set plus a bounded recovery sweep of
  // confirmed/unassigned offered or dropped bookings. The sweep repairs a
  // request that stopped after resolving/releasing a job but before rematching.
  const { data: recoveryBookings, error: recoveryError } = await sb
    .from('bookings')
    .select('id')
    .eq('status', 'confirmed')
    .is('assembler_id', null)
    .in('dispatch_status', ['offered', 'dropped'])
    .or('dispatch_paused.is.null,dispatch_paused.eq.false')
    .or('needs_manual_dispatch.is.null,needs_manual_dispatch.eq.false');

  if (recoveryError) {
    console.error('expire-offers: recovery lookup error', recoveryError);
    results.errors.push('recovery lookup: ' + recoveryError.message);
  }

  const affectedBookingIds = [...new Set([
    ...(expiredOffers || []).map(o => o.booking_id),
    ...(recoveryBookings || []).map(b => b.id),
  ])];
  if (!affectedBookingIds.length) {
    console.log('expire-offers: no affected bookings', { expired: results.expired });
    return res.status(200).json({ ok: true, ...results });
  }

  for (const bookingId of affectedBookingIds) {
    try {
      // Fetch context for owner-visible logging. The row-locked RPC below is
      // the source of truth for whether this round retries or needs an owner.
      const { data: booking, error: bookingError } = await sb
        .from('bookings')
        .select('id, ref, service, customer_name, dispatch_attempt, assembler_id, status, dispatch_paused, needs_manual_dispatch')
        .eq('id', bookingId)
        .single();

      if (bookingError || !booking) {
        throw bookingError || new Error('Booking not found');
      }

      let finalization = await finalizeDispatchRound(sb, {
        bookingId,
        maxAttempts: MAX_ATTEMPTS,
      });

      if (finalization.action === 'retry') {
        const retry = await dispatchBooking(bookingId);
        results.retried.push({
          bookingId,
          ref: booking.ref,
          attempt: finalization.attempt + 1,
          result: retry.message,
          dispatched: retry.dispatched || 0,
        });
        console.log(`expire-offers: retry dispatch ${booking.ref} attempt ${finalization.attempt + 1}`, retry);

        if (retry?.code === 'DISPATCH_PAYMENT_NOT_VERIFIED') {
          await holdDispatchForPaymentReconciliation(sb, {
            booking,
            source: 'expire-offers',
            detail: retry.message,
          });
          results.paymentHeld.push({ bookingId, ref: booking.ref });
          finalization = { action: 'payment_hold', ref: booking.ref, attempt: finalization.attempt };
        }

        // No candidates, an insert conflict, or another safe dispatch failure
        // must produce explicit owner action rather than an idle booking.
        if (!retry?.dispatched && retry?.code !== 'DISPATCH_PAYMENT_NOT_VERIFIED') {
          // Exhausted the roster rather than hit a fault: everyone eligible already
          // has this job. Hand it back to nobody — keep it live with the Easers who
          // can actually take it.
          const rosterExhausted = /already received offers|No available Easers|No eligible Easers/i
            .test(retry?.message || '');
          let renewed = 0;
          if (KEEP_OFFERS_OPEN && rosterExhausted) {
            const renewedUntil = new Date(Date.now() + RENEW_MINUTES * 60 * 1000).toISOString();
            const { data: renewedRows, error: renewErr } = await sb
              .from('dispatch_offers')
              .update({ offer_status: 'sent', expires_at: renewedUntil, timed_out_at: null })
              .eq('booking_id', bookingId)
              // Only offers this sweep just expired. A DECLINED offer is never
              // revived, and an accepted/superseded one must never be reopened.
              .eq('offer_status', 'expired')
              .select('id');
            if (renewErr) {
              console.error('expire-offers: renew failed', bookingId, renewErr.message);
            } else {
              renewed = (renewedRows || []).length;
            }
          }

          if (renewed > 0) {
            results.renewed.push({ bookingId, ref: booking.ref, offers: renewed, reason: retry?.message });
            console.log(`expire-offers: kept ${renewed} offer(s) open on ${booking.ref} — no other Easer to try`);
            // Deliberately NOT re-notified. This cron runs every 10 minutes; a
            // fresh email each pass would be harassment, and the job is already
            // sitting in their app. Renewal keeps it visible, it does not re-ping.
            finalization = { action: 'kept_open', ref: booking.ref, attempt: finalization.attempt };
          } else {
            finalization = await finalizeDispatchRound(sb, {
              bookingId,
              maxAttempts: MAX_ATTEMPTS,
              forceManual: true,
            });
          }
        }
      }

      if (finalization.action === 'manual_required') {
        results.flagged.push({ bookingId, ref: booking.ref, attempts: finalization.attempt });
        await notifyOwnerManualDispatch(sb, {
          booking,
          source: 'expire-offers',
          reason: `All offers expired or were resolved after ${finalization.attempt} dispatch attempt(s).`,
          metadata: { attempt: finalization.attempt },
        });
        console.log(`expire-offers: flagged ${booking.ref} for manual dispatch after ${finalization.attempt} attempts`);
      }
    } catch (err) {
      console.error('expire-offers: error processing booking', bookingId, err.message);
      results.errors.push(`${bookingId}: ${err.message}`);
    }
  }

  console.log('expire-offers complete:', results);
  await logCron('expire-offers', {
    records: results.expired + results.retried.length + results.flagged.length,
    status: results.errors.length ? 'partial' : 'ok',
    error: results.errors.length ? results.errors.join('; ') : null,
  });
  return res.status(200).json({ ok: true, ...results });
}

// Tell the Easer they are offline, why, and how to come back. Every channel is
// best effort; the offline change already stands.
export async function notifyEaserSetOffline(sb, easerId, streak) {
  const { data: easer } = await sb.from('profiles')
    .select('id, full_name, email, phone, sms_consent_at, sms_opted_out_at')
    .eq('id', easerId).maybeSingle();
  if (!easer?.id) return;
  const meta = { notificationType: 'easer_auto_offline', recipientType: 'easer', recipientUserId: easer.id, disableDedupe: true };
  const line = `${streak} job offers in a row expired without an answer, so we set you offline to keep jobs moving.`;
  await sendPushToUser(easer.id, {
    title: 'You are offline',
    body: `${line} Go online again when you can take jobs.`,
    url: '/assembler/',
  }, meta).catch(() => null);
  await sendSms({
    recipient: easer,
    body: `AssembleAtEase: ${line} Open the app and go online again when you can take jobs. This is not a strike.`,
    meta,
  }).catch(() => null);
  if (easer.email) {
    await sendEmail({
      to: easer.email,
      subject: 'You are offline on AssembleAtEase',
      html: `<p>Hi ${esc(String(easer.full_name || 'there').split(' ')[0])},</p>
<p>${esc(line)}</p>
<p>Go online again from Today in the Easer app whenever you are ready to take jobs. This is not a strike and does not affect your standing.</p>
<p>If you cannot take an offer, decline it instead of letting it expire: a decline sends the job to the next Easer right away. After ${EASER_RELIABILITY_POLICY.unansweredOffersOffline} offers in a row expire, you are set offline again.</p>`,
      replyTo: 'service@assembleatease.com',
      meta,
    }).catch(() => null);
  }
}
