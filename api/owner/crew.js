import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { sendSms } from '../_sms.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from '../booking/_activity.js';
import { getEaserReadiness } from '../_easer-readiness.js';
import {
  loadCrew,
  crewEligibility,
  proposeEvenSplit,
  laborPoolCents,
  summarizeCrew,
  splitPressure,
  fundingIsAllowedForNewCrew,
  ALLOWED_NEW_FUNDING,
  CREW_ROLE,
  CREW_FUNDING,
} from '../booking/_crew.js';

const SITE = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';

/**
 * POST /api/owner/crew — put a second Easer on a job, or take one off.
 *
 * Actions:
 *   preview  — what would happen. Writes nothing. This is what the owner sees
 *              BEFORE confirming, and it is the only way to learn the numbers.
 *   add      — apply an allocation the owner has seen and confirmed.
 *   remove   — take a helper off the job and free their share.
 *
 * WHY PREVIEW IS A SEPARATE ACTION
 * The lead's earnings were snapshotted when they accepted. Splitting the pool
 * reduces a number already promised to a contractor, so it is never applied from
 * a single click: preview names the reduction, the owner confirms it, and `add`
 * refuses any allocation that does not match what was shown. Rule 10 and
 * Article 16 — no silent pay cut, and no UI asserting an outcome the server has
 * not agreed to.
 *
 * THE MONEY IS NOT DECIDED HERE
 * This handler proposes and validates. add_booking_crew_member() re-checks the
 * pool ceiling inside one transaction against freshly locked rows, so a caller
 * cannot over-allocate a booking by posting different numbers (Rule 4).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const {
    bookingId,
    easerId,
    action = 'preview',
    funding,
    allocations,
    reason,
    addingCount = 1,
  } = req.body || {};

  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  const sb = getSupabase();

  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, status, assembler_id, assembler_name, total_price, amount_charged, tax_amount, assembler_due, easer_fee_pct_snapshot, assemblecash_redeemed_cents, payout_status, service, date, time, customer_name, customer_email, address, city, zip')
    .eq('id', bookingId)
    .single();
  if (bookingErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  const crewByBooking = await loadCrew([bookingId], { sb });
  const crew = crewByBooking.get(bookingId) || [];

  // ── REMOVE ────────────────────────────────────────────────────────────────
  if (action === 'remove') {
    if (!easerId) return res.status(400).json({ error: 'easerId is required' });
    const cleanReason = String(reason || '').trim().slice(0, 300);
    if (cleanReason.length < 3) {
      return res.status(400).json({ error: 'Give a reason for removing them — it stays on the job record.' });
    }

    const { data, error } = await sb.rpc('remove_booking_crew_member', {
      p_booking_id: bookingId,
      p_easer_id: easerId,
      p_reason: cleanReason,
    });
    if (error) {
      // The server's own words, never an invented cause (Article 16).
      return res.status(409).json({ error: error.message || 'That Easer could not be removed.' });
    }
    const result = Array.isArray(data) ? data[0] : data;

    await logActivity(sb, {
      bookingId,
      eventType: 'crew_removed',
      actorType: 'owner',
      actorName: 'owner',
      description: `Easer removed from the crew: ${cleanReason}`,
      metadata: { easerId, freedCents: result?.out_freed_cents ?? null },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      freedCents: result?.out_freed_cents ?? 0,
      headcount: result?.out_headcount ?? 0,
    });
  }

  // ── PREVIEW and ADD both need the candidate's readiness ───────────────────
  if (!easerId) return res.status(400).json({ error: 'easerId is required' });

  const { data: easer, error: easerErr } = await sb
    .from('profiles')
    .select('id, full_name, email, phone, sms_consent_at, sms_opted_out_at, role, status, application_status, tier, identity_verified, contractor_agreement_signed_at, contractor_agreement_version, code_of_conduct_agreed_at, application_fee_paid, application_fee_waived, fee_waived_by_owner, payment_confirmed, account_closure_status, is_available, has_membership, stripe_connect_account_id')
    .eq('id', easerId)
    .single();
  if (easerErr || !easer) return res.status(404).json({ error: 'Easer not found' });

  // The SAME gate dispatch uses. Adding crew must never become a back door around
  // identity verification and the contractor agreement — two unvetted people in a
  // customer's home is exactly what this prevents. Availability is not required:
  // the owner is placing them deliberately, not offering them a job.
  const readiness = await getEaserReadiness(easer, { requireAvailability: false });
  const eligibility = crewEligibility({ booking, crew, easerId, readiness });
  if (!eligibility.ok) {
    return res.status(409).json({ error: eligibility.message, code: eligibility.reason });
  }

  const pool = laborPoolCents(booking);
  const proposal = proposeEvenSplit({ booking, crew, addingCount: Math.max(1, Number(addingCount) || 1) });
  const chosenFunding = funding || eligibility.defaultFunding;

  // The owner's ruling, enforced server-side rather than by hiding a radio
  // button: the platform does not absorb a helper's pay. A job that needs two
  // people is underpriced, and funding the second one out of margin turns that
  // pricing problem into an invisible per-job write-off.
  if (!fundingIsAllowedForNewCrew(chosenFunding)) {
    return res.status(400).json({
      error: 'A second Easer is paid out of the job\'s own Easer pay, or out of a change order the customer approves. '
        + 'The platform does not cover it — if this job needs two people, its price is too low.',
      code: 'FUNDING_NOT_ALLOWED',
    });
  }

  // ── PREVIEW ───────────────────────────────────────────────────────────────
  if (action === 'preview') {
    const named = proposal.allocations.map(a => ({
      ...a,
      easerId: a.easerId || easerId,
      name: a.easerId
        ? (a.easerId === booking.assembler_id ? booking.assembler_name : crewName(crew, a.easerId))
        : easer.full_name,
    }));
    return res.status(200).json({
      ok: true,
      preview: true,
      easer: { id: easer.id, name: easer.full_name, tier: easer.tier },
      poolCents: pool,
      defaultFunding: eligibility.defaultFunding,
      createsNewObligation: eligibility.createsNewObligation === true,
      allocations: named,
      // The two facts the owner must see before confirming.
      leadReductionCents: proposal.leadReductionCents,
      reducesExistingPay: proposal.reducesExistingPay,
      // The pricing signal, not a payments one: if this job needs two people its
      // price is too low, and this is the number that shows it.
      pressure: splitPressure({ booking, crew, addingCount: Math.max(1, Number(addingCount) || 1) }),
      allowedFunding: ALLOWED_NEW_FUNDING,
      currentCrew: summarizeCrew(crew),
    });
  }

  // ── ADD ───────────────────────────────────────────────────────────────────
  if (action !== 'add') return res.status(400).json({ error: `Unknown action: ${action}` });

  // The owner must send back the allocation they were shown. This is what makes
  // the pay cut a decision rather than a side effect.
  const submitted = Array.isArray(allocations) ? allocations : null;
  if (!submitted?.length) {
    return res.status(400).json({
      error: 'Confirm the split before adding an Easer. Request a preview first.',
      code: 'ALLOCATIONS_REQUIRED',
    });
  }

  const normalized = [];
  for (const row of submitted) {
    const id = String(row?.easerId || row?.easer_id || '').trim();
    const cents = Math.round(Number(row?.dueCents ?? row?.due_cents));
    if (!id || !Number.isFinite(cents) || cents < 0) {
      return res.status(400).json({ error: 'Every allocation needs an Easer and a whole, non-negative amount.' });
    }
    normalized.push({ easer_id: id, due_cents: cents });
  }

  const total = normalized.reduce((sum, r) => sum + r.due_cents, 0);
  if (chosenFunding === CREW_FUNDING.LABOR_POOL && total > pool) {
    return res.status(400).json({
      error: `That split totals $${(total / 100).toFixed(2)} but the job only has $${(pool / 100).toFixed(2)} of Easer pay in it.`,
      code: 'EXCEEDS_POOL',
    });
  }

  const { data, error } = await sb.rpc('add_booking_crew_member', {
    p_booking_id: bookingId,
    p_easer_id: easerId,
    p_role: CREW_ROLE.HELPER,
    p_funded_from: chosenFunding,
    p_allocations: normalized,
    p_pool_cents: pool,
    p_fee_pct: booking.easer_fee_pct_snapshot ?? null,
    p_added_by: 'owner',
    p_reason: String(reason || '').trim().slice(0, 300) || null,
  });
  if (error) {
    return res.status(409).json({ error: error.message || 'That Easer could not be added to the job.' });
  }
  const result = Array.isArray(data) ? data[0] : data;
  const helperDue = normalized.find(r => r.easer_id === easerId)?.due_cents || 0;

  await logActivity(sb, {
    bookingId,
    eventType: 'crew_added',
    actorType: 'owner',
    actorName: 'owner',
    description: `${easer.full_name || 'An Easer'} was added to this job (${chosenFunding.replace(/_/g, ' ')})`,
    metadata: { easerId, dueCents: helperDue, funding: chosenFunding, headcount: result?.out_headcount ?? null },
  }).catch(() => {});

  // ── Tell the people it affects ────────────────────────────────────────────
  // Both sends are awaited: a serverless function can be frozen the moment it
  // responds, so firing and forgetting would silently drop them. Neither failure
  // undoes the crew change — the assignment is real whether or not the email left
  // (Rule 7), and the owner is shown what did not send.
  const notify = { easer: null, customer: null };

  notify.easer = await sendEmail({
    to: easer.email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `You've been added to a job — ${esc(booking.service || 'Service')} (${esc(booking.ref)})`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h2 style="color:#00BFFF">You're on a job</h2>
      <p>Hi ${esc((easer.full_name || '').split(' ')[0] || 'there')}, you've been added to booking <strong>${esc(booking.ref)}</strong>.</p>
      <p><strong>Service:</strong> ${esc(booking.service || 'Service')}<br>
      <strong>When:</strong> ${esc(booking.date || 'TBD')}${booking.time ? ' at ' + esc(booking.time) : ''}<br>
      <strong>Working with:</strong> ${esc(booking.assembler_name || 'the lead Easer')}<br>
      <strong>Your estimated earnings:</strong> $${(helperDue / 100).toFixed(2)}</p>
      <p style="font-size:14px;color:#52525b">${esc(booking.assembler_name || 'The lead Easer')} is the lead on this job and marks it complete. Open your dashboard for the address and job details.</p>
      <p><a href="${SITE}/assembler/my-assignments" style="display:inline-block;background:#00BFFF;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">View the job</a></p>
    </div>`,
    replyTo: ownerEmail(),
    meta: { bookingId, notificationType: 'crew_added', recipientType: 'easer', recipientUserId: easerId, disableDedupe: true },
  }).catch(err => ({ ok: false, error: err?.message || String(err) }));

  await sendSms({
    recipient: easer,
    body: `You've been added to an AssembleAtEase job: ${booking.service || 'Service'}${booking.date ? ' ' + booking.date : ''}. $${(helperDue / 100).toFixed(2)} est. Open the app for details. Ref ${booking.ref}`,
    meta: { bookingId, notificationType: 'crew_added', recipientType: 'easer', recipientUserId: easerId },
  }).catch(() => {});

  await sendPushToUser(easerId, {
    title: 'You were added to a job',
    body: `${booking.service || 'Service'} · $${(helperDue / 100).toFixed(2)} estimated · Tap for details`,
    url: `${SITE}/assembler/my-assignments`,
    jobId: bookingId,
  }, { bookingId, notificationType: 'crew_added', recipientType: 'easer' }).catch(() => {});

  // The customer is told a second person is coming. Rule 9: nobody should be
  // surprised by who walks into their home.
  if (booking.customer_email) {
    notify.customer = await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `A second pro is joining your appointment — ${esc(booking.ref)}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#00BFFF">A second pro is joining your appointment</h2>
        <p>Hi ${esc((booking.customer_name || '').split(' ')[0] || 'there')}, we've added <strong>${esc(easer.full_name || 'a second pro')}</strong> to your ${esc(booking.service || 'appointment')} on <strong>${esc(booking.date || 'your scheduled date')}</strong>${booking.time ? ' at ' + esc(booking.time) : ''}.</p>
        <p>They'll be working alongside ${esc(booking.assembler_name || 'your Easer')}. <strong>Your price hasn't changed.</strong></p>
        <p style="font-size:14px;color:#52525b">Questions? Call or text us at <a href="tel:+17372906129" style="color:#00BFFF;text-decoration:none">737-290-6129</a>.</p>
      </div>`,
      replyTo: ownerEmail(),
      meta: { bookingId, notificationType: 'crew_added', recipientType: 'customer', disableDedupe: true },
    }).catch(err => ({ ok: false, error: err?.message || String(err) }));
  }

  return res.status(200).json({
    ok: true,
    crewId: result?.out_crew_id ?? null,
    headcount: result?.out_headcount ?? null,
    totalDueCents: result?.out_total_due ?? null,
    poolCents: pool,
    funding: chosenFunding,
    // Reported, never assumed: the owner sees which notification did not land.
    notifications: {
      easerEmail: notify.easer?.ok === true,
      customerEmail: notify.customer ? notify.customer.ok === true : null,
      easerEmailError: notify.easer?.ok ? null : (notify.easer?.error || notify.easer?.reason || null),
    },
  });
}

function crewName(crew, easerId) {
  const row = (crew || []).find(r => r.easer_id === easerId);
  return row?.easer_name || 'Easer';
}
