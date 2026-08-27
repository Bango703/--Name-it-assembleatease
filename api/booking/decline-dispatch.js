import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { logActivity } from './_activity.js';
import { DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { declineDispatchOffer, finalizeDispatchRound, holdDispatchForPaymentReconciliation, notifyOwnerManualDispatch } from './_dispatch-safety.js';

/**
 * POST /api/booking/decline-dispatch
 * Easer declines a dispatch offer.
 * Requires Easer JWT auth.
 * Body: { bookingId, token, reason? }
 *
 * Reason values: scheduling_conflict | too_far | not_my_skill | unavailable | other
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await userClient.auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { bookingId, token, reason } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const now = new Date().toISOString();

  // ── Owner-assigned job with no dispatch offer ───────────────────────────────
  // A token exists so an UNAUTHENTICATED email link can act. In the app the Easer
  // is already authenticated above, and a manually assigned job has no
  // dispatch_offers row at all — api/booking/assign.js stores its token on
  // bookings.assignment_token and explicitly sets dispatch_token to null.
  //
  // The result was a Decline button that did nothing: the app had no token to
  // send, and this endpoint only ever looked in dispatch_offers. An Easer given a
  // job by hand could not refuse it, which strands the job on someone who is not
  // going to do it.
  //
  // Identity here is stronger than a token, not weaker: the JWT proves who they
  // are and assembler_id proves the job is theirs.
  if (!token) {
    const { data: assigned, error: assignedErr } = await sb
      .from('bookings')
      .select('id, ref, status, assembler_id, assembler_name, assembler_accepted_at, financial_operation_key')
      .eq('id', bookingId)
      .eq('assembler_id', user.id)
      .maybeSingle();
    if (assignedErr) {
      return res.status(500).json({ error: 'Could not verify this job. Please try again.' });
    }
    if (!assigned) {
      return res.status(404).json({ error: 'This job is not assigned to you.' });
    }
    if (assigned.assembler_accepted_at) {
      return res.status(409).json({
        error: 'You already accepted this job. Use Drop Job if you can no longer do it, so the owner is told.',
        code: 'ALREADY_ACCEPTED',
      });
    }
    if (assigned.financial_operation_key) {
      return res.status(409).json({ error: 'This job is briefly locked while a payment action finishes. Try again in a moment.' });
    }
    // Hand it straight back. Same end state as declining an offer: unassigned and
    // dispatchable, with nothing owed by or to the Easer who never accepted.
    const { data: releasedRows, error: releaseErr } = await sb
      .from('bookings')
      .update({
        assembler_id: null,
        assembler_name: null,
        assigned_at: null,
        assembler_accepted_at: null,
        assignment_token: null,
        dispatch_status: null,
        // Same reason as release: assign.js paused dispatch for this booking, so
        // declining must un-pause it or the job is stranded — nobody assigned and
        // dispatch refusing to run.
        dispatch_paused: false,
        needs_manual_dispatch: true,
      })
      .eq('id', assigned.id)
      .eq('assembler_id', user.id)
      .is('assembler_accepted_at', null)
      .select('id');
    if (releaseErr) {
      console.error('decline assigned-job release error:', releaseErr);
      return res.status(500).json({ error: 'Could not decline this job. Nothing was changed.' });
    }
    if (!releasedRows?.length) {
      return res.status(409).json({ error: 'This job changed while you were declining it. Refresh and check.' });
    }

    await logActivity(sb, {
      bookingId: assigned.id,
      eventType: 'assignment_declined',
      actor: 'easer',
      description: `${assigned.assembler_name || 'Easer'} declined an owner-assigned job`
        + (reason ? ` — ${String(reason).slice(0, 300)}` : ''),
    }).catch(() => {});

    // The owner assigned this by hand, so the owner must be told by hand — there
    // is no dispatch retry behind it to pick the job back up.
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Easer declined an assigned job — ${assigned.ref}`,
      html: `<p><strong>${esc(assigned.assembler_name || 'The assigned Easer')}</strong> declined <strong>${esc(assigned.ref)}</strong>.</p>
             ${reason ? `<p>Reason: ${esc(String(reason).slice(0, 300))}</p>` : ''}
             <p>The booking is unassigned and flagged for manual assignment. Nothing was charged or paid.</p>`,
      replyTo: ownerEmail(),
      meta: { bookingId: assigned.id, notificationType: 'easer_declined_assignment', recipientType: 'owner', disableDedupe: true },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      declined: true,
      assignedJob: true,
      message: 'Job declined. It has been handed back to the owner.',
    });
  }

  // ── Find open offer ────────────────────────────────────────────────────────
  const { data: offer, error: offerLookupError } = await sb
    .from('dispatch_offers')
    .select('*')
    .eq('token', token)
    .eq('easer_id', user.id)
    .eq('booking_id', bookingId)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
    .maybeSingle();

  if (offerLookupError) {
    console.error('decline-dispatch offer lookup error:', offerLookupError);
    return res.status(500).json({ error: 'Could not verify this offer. Please try again.' });
  }

  if (!offer) {
    // Check if it already expired or was declined
    const { data: anyOffer, error: resolvedLookupError } = await sb
      .from('dispatch_offers')
      .select('offer_status')
      .eq('token', token)
      .eq('easer_id', user.id)
      .eq('booking_id', bookingId)
      .maybeSingle();

    if (resolvedLookupError) {
      return res.status(500).json({ error: 'Could not verify this offer. Please try again.' });
    }

    if (anyOffer?.offer_status === DISPATCH_OFFER_STATUS.EXPIRED) {
      return res.status(410).json({ error: 'Offer already expired' });
    }
    if (anyOffer?.offer_status === DISPATCH_OFFER_STATUS.ACCEPTED || anyOffer?.offer_status === DISPATCH_OFFER_STATUS.SUPERSEDED) {
      return res.status(409).json({ error: 'Job was already accepted' });
    }
    return res.status(404).json({ error: 'Offer not found or already resolved' });
  }

  // Suspended or closing Easers must still be able to safely release an offer,
  // but a non-Easer JWT must never mutate dispatch state.
  const { data: easerProfile, error: easerProfileError } = await sb
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .maybeSingle();
  if (easerProfileError) {
    console.error('decline-dispatch Easer role lookup error:', easerProfileError);
    return res.status(503).json({ error: 'Easer role could not be verified. The offer was not changed.' });
  }
  if (!easerProfile || easerProfile.role !== 'assembler') {
    return res.status(403).json({ error: 'An Easer account is required to decline job offers.' });
  }

  // Resolve sent->declined and make the final-round decision in one database
  // transaction. A simultaneous accept/expiry cannot be overwritten, and the
  // last decline at max attempts cannot commit without owner-action state.
  const MAX_ATTEMPTS = parseInt(process.env.DISPATCH_MAX_ATTEMPTS || '3', 10);
  let declineResolution;
  try {
    declineResolution = await declineDispatchOffer(sb, {
      offerId: offer.id,
      bookingId,
      easerId: user.id,
      reason,
      declinedAt: now,
      maxAttempts: MAX_ATTEMPTS,
    });
  } catch (declineError) {
    console.error('decline-dispatch atomic update error:', declineError);
    return res.status(500).json({ error: 'Could not decline this offer. Please try again.' });
  }
  if (declineResolution.action === 'expired') {
    return res.status(410).json({ error: 'This offer has expired.' });
  }
  if (['invalid_offer', 'resolved', 'unknown'].includes(declineResolution.action)) {
    return res.status(409).json({ error: 'This offer was already resolved.' });
  }

  // Apply 2-hour decline penalty to Easer profile
  const { error: penaltyError } = await sb.from('profiles')
    .update({ last_dispatch_declined_at: now })
    .eq('id', user.id);
  if (penaltyError) console.error('decline-dispatch profile penalty error:', penaltyError);

  // Get Easer name for notifications
  const easerName = easerProfile.full_name || 'An Easer';

  // Get booking for context
  const { data: booking, error: bookingLookupError } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, assembler_id, dispatch_attempt, status, dispatch_paused, needs_manual_dispatch')
    .eq('id', bookingId)
    .single();

  // Notify owner of the individual decline. Notification failure never changes
  // the successfully persisted offer state.
  const reasonLabels = {
    scheduling_conflict: 'Scheduling conflict',
    too_far: 'Location too far',
    not_my_skill: 'Outside service scope',
    unavailable: 'Currently unavailable',
    other: 'Other',
  };
  const declineEmail = await sendEmail({
    to:   ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Offer Declined — ${esc(booking?.ref || bookingId)}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h3 style="color:#f59e0b">Job Offer Declined</h3>
      <p><strong>${esc(easerName)}</strong> declined the offer for booking <strong>${esc(booking?.ref || '')}</strong> (${esc(booking?.service || '')}).</p>
      <p><strong>Reason:</strong> ${esc(reasonLabels[reason] || reason || 'No reason given')}</p>
      <p>The dispatch engine will automatically retry if other Easers are available.</p>
      <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">View in owner dashboard</a></p>
    </div>`,
    meta: { bookingId, notificationType: 'dispatch_offer_declined', recipientType: 'owner' },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  let dispatchOutcome = { ...declineResolution, warning: null };

  if (bookingLookupError || !booking) {
    dispatchOutcome.warning = 'Offer declined. It may take a moment for this job to leave your offers.';
    console.error('decline-dispatch booking lookup error:', bookingLookupError);
  } else {
    try {
      if (declineResolution.action === 'retry') {
        const retry = await dispatchBooking(bookingId);
        dispatchOutcome.retry = retry;

        if (retry?.code === 'DISPATCH_PAYMENT_NOT_VERIFIED') {
          await holdDispatchForPaymentReconciliation(sb, {
            booking,
            source: 'decline-dispatch',
            detail: retry.message,
          });
          dispatchOutcome.action = 'payment_hold';
        }

        // A retry that created no offers must not leave the booking in an idle
        // automatic loop. If another request created offers, the row-locked RPC
        // returns open_offers and leaves automatic dispatch active.
        if (!retry?.dispatched && retry?.code !== 'DISPATCH_PAYMENT_NOT_VERIFIED') {
          const forced = await finalizeDispatchRound(sb, {
            bookingId,
            maxAttempts: MAX_ATTEMPTS,
            forceManual: true,
          });
          dispatchOutcome.action = forced.action;
          if (forced.action === 'manual_required') {
            await notifyOwnerManualDispatch(sb, {
              booking,
              source: 'decline-dispatch',
              reason: `All current offers were resolved and the next dispatch round created no offers (${retry?.message || 'unknown dispatch result'}).`,
              metadata: { attempt: booking.dispatch_attempt || 0, retry },
            });
          }
        }
      } else if (declineResolution.action === 'manual_required') {
        await notifyOwnerManualDispatch(sb, {
          booking,
          source: 'decline-dispatch',
          reason: `All offers in dispatch attempt ${declineResolution.attempt} were resolved without an acceptance.`,
          metadata: { attempt: declineResolution.attempt, finalDeclineEaserId: user.id },
        });
      }
    } catch (dispatchError) {
      console.error('decline-dispatch finalization error:', dispatchError);
      dispatchOutcome.warning = 'Offer declined. It may take a moment for this job to leave your offers.';
      await logActivity(sb, {
        bookingId,
        eventType: 'dispatch_finalization_failed',
        actorType: 'system',
        actorName: 'decline-dispatch',
        description: `${booking.ref || bookingId} was declined, but dispatch finalization failed`,
        metadata: { error: dispatchError?.message || String(dispatchError) },
      });
    }
  }

  await logActivity(sb, {
    bookingId,
    eventType: 'dispatch_offer_declined',
    actorType: 'easer',
    actorId: user.id,
    actorName: easerName,
    description: `${easerName} declined dispatch offer${booking?.ref ? ` for ${booking.ref}` : ''}`,
    metadata: {
      reason: reason || 'no_reason',
      dispatchAction: dispatchOutcome.action,
      attempt: booking?.dispatch_attempt || null,
      ownerEmailDelivered: Boolean(declineEmail?.ok),
    },
  });

  console.log(`decline-dispatch: ${easerName} declined ${booking?.ref || bookingId}, reason=${reason}`);
  return res.status(200).json({
    ok: true,
    message: 'Offer declined. You will not receive further offers for this job.',
  });
}
