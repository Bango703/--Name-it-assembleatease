import { randomUUID } from 'crypto';
import { getSupabase } from '../_supabase.js';
import { sendEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';

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
export async function dispatchBooking(bookingId, { dryRun = false } = {}) {
  const sb = getSupabase();

  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();
  if (bErr || !booking) return { dispatched: 0, message: 'Booking not found' };
  if (booking.status !== 'confirmed') return { dispatched: 0, message: `Booking not confirmed (status: ${booking.status})` };
  if (booking.assembler_id) return { dispatched: 0, message: 'Already assigned' };
  if (booking.dispatch_paused) return { dispatched: 0, message: 'Dispatch paused by owner' };
  if (booking.needs_manual_dispatch) return { dispatched: 0, message: 'Flagged for manual dispatch' };
  if ((booking.dispatch_attempt || 0) >= MAX_ATTEMPTS) {
    return { dispatched: 0, message: `Max dispatch attempts (${MAX_ATTEMPTS}) reached` };
  }

  // Deduplication via dispatch_offers table: check for open (sent) offers
  if (!dryRun) {
    const { data: openOffers } = await sb
      .from('dispatch_offers')
      .select('id, expires_at')
      .eq('booking_id', bookingId)
      .eq('offer_status', 'sent');

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
    .select('id, full_name, email, phone, city, zip, status, tier, rating, completed_jobs, has_membership, is_available, last_assigned_at, acceptance_rate, active_jobs_today, last_dispatch_declined_at')
    .eq('role', 'assembler')
    .eq('status', 'active')
    .eq('identity_verified', true)
    .in('tier', ['starter', 'professional', 'elite'])
    .not('phone', 'is', null);

  if (!easers || !easers.length) return { dispatched: 0, message: 'No eligible Easers in system' };

  // ── Filter by availability and service area ───────────────────────────────
  // Note: MAX_DAILY_JOBS cap is applied below with authoritative booking counts.
  // Do NOT filter on active_jobs_today here — the profile counter can be stale.
  let eligible = easers.filter(e => {
    if (!e.is_available) return false;
    if (bookingCity && e.city) {
      const bc = bookingCity.toLowerCase();
      const ec = (e.city || '').toLowerCase();
      if (!ec.includes(bc) && !bc.includes(ec)) return false;
    }
    return true;
  });

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
      .in('status', ['confirmed', 'en_route', 'arrived', 'in_progress']);

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

  // Filter out Easers who already have an open offer for this booking
  const easerIdsWithOpenOffers = new Set();
  if (!dryRun) {
    const { data: existingOffers } = await sb
      .from('dispatch_offers')
      .select('easer_id')
      .eq('booking_id', bookingId)
      .in('offer_status', ['sent', 'accepted', 'superseded']);
    (existingOffers || []).forEach(o => easerIdsWithOpenOffers.add(o.easer_id));
  }

  const scoreable = eligible.filter(e => !easerIdsWithOpenOffers.has(e.id));
  if (!scoreable.length) return { dispatched: 0, message: 'All eligible Easers already received offers' };

  // ── Enhanced scoring ──────────────────────────────────────────────────────
  const isHighValue = (booking.total_price || 0) > 20000; // > $200

  const scored = scoreable.map(e => {
    let score = e.tier === 'elite' ? 400 : e.tier === 'professional' ? 250 : 100;

    // High-value job: penalize starter Easers
    if (isHighValue && e.tier === 'starter') score -= 100;

    if (e.has_membership) score += 150;
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
    return { dispatched: 0, message: 'Failed to create offer records' };
  }

  // Build token map: easer_id → token
  const tokenByEaser = {};
  (insertedOffers || []).forEach(o => { tokenByEaser[o.easer_id] = o.token; });

  // ── Atomic booking update ────────────────────────────────────────────────
  // Single update — atomic guard: only proceed if still unassigned
  const { error: bookingUpdateErr } = await sb.from('bookings').update({
    dispatch_attempt:    attemptNumber,
    dispatch_offered_at: now,
    dispatch_status:     'offered',
    dispatch_offered_to: top.map(e => e.id), // keep for backwards compat
    needs_manual_dispatch: false,             // clear manual flag on retry
  }).eq('id', bookingId).is('assembler_id', null);

  if (bookingUpdateErr) {
    // Booking was just assigned — cancel the offers we just created
    await sb.from('dispatch_offers')
      .update({ offer_status: 'cancelled' })
      .eq('booking_id', bookingId)
      .in('id', (insertedOffers || []).map(o => o.id));
    return { dispatched: 0, message: 'Booking assigned while dispatching — offers cancelled' };
  }

  // ── Send notifications (non-blocking) ────────────────────────────────────
  let notified = 0;
  for (const easer of top) {
    const token    = tokenByEaser[easer.id];
    const acceptUrl = `${SITE}/assembler/my-assignments?accept=${bookingId}&token=${token}`;
    const declineUrl = `${SITE}/assembler/my-assignments?decline=${bookingId}&token=${token}`;

    sendPushToUser(easer.id, {
      title: 'New Job Available!',
      body:  `${booking.service || 'Service'} · ${booking.date || ''}${booking.time ? ' at ' + booking.time : ''} · Accept in ${OFFER_TTL_MIN} min`,
      url:   acceptUrl,
      jobId: bookingId,
      urgent: true,
    }, { bookingId, notificationType: 'dispatch_offer', recipientType: 'easer' }).catch(() => {});

    try {
      await sendEmail({
        to:       easer.email,
        from:     'AssembleAtEase <booking@assembleatease.com>',
        subject:  `New Job Available — ${booking.service || 'Service'} in ${bookingCity}`,
        html:     buildOfferEmail(easer, booking, bookingCity, acceptUrl, declineUrl, expiresAt),
        replyTo:  'service@assembleatease.com',
        meta:     { bookingId, notificationType: 'dispatch_offer', recipientType: 'easer', recipientUserId: easer.id },
      });
      // Mark notification sent
      await sb.from('dispatch_offers')
        .update({ notification_sent: true })
        .eq('booking_id', bookingId)
        .eq('easer_id', easer.id)
        .eq('attempt_number', attemptNumber);
      notified++;
    } catch (err) {
      console.error('Dispatch email error:', easer.email, err.message);
    }
  }

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
    dispatched: notified,
    message: notified > 0 ? `Offered to ${notified} Easer(s) — expires in ${OFFER_TTL_MIN} min` : 'Failed to send notifications',
    offeredTo: top.map(e => ({
      name: e.full_name,
      tier: e.tier,
      score: e._score,
      token: tokenByEaser[e.id],
    })),
    attemptNumber,
    expiresAt,
  };
}

// ── Address helpers ───────────────────────────────────────────────────────────
function extractCity(address) {
  const parts = address.split(',');
  if (parts.length >= 2) return parts[parts.length - 2].trim().replace(/\s+\w{2}\s*$/, '').trim();
  return 'Austin';
}

function extractZip(address) {
  const m = address.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

// ── Offer email ───────────────────────────────────────────────────────────────
function buildOfferEmail(easer, booking, city, acceptUrl, declineUrl, expiresAt) {
  const firstName   = (easer.full_name || 'there').split(' ')[0];
  const payEstimate = booking.total_price
    ? '$' + Math.round((booking.total_price / 100) * (easer.has_membership ? 0.82 : 0.75)).toLocaleString() + '–$' + Math.round((booking.total_price / 100) * (easer.has_membership ? 0.85 : 0.78)).toLocaleString()
    : null;
  const expiryMin   = Math.round((new Date(expiresAt) - Date.now()) / 60000);
  const tierLabel   = { starter: 'Starter', professional: 'Professional', elite: 'Elite' }[easer.tier] || easer.tier;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:linear-gradient(135deg,#003d47,#0097a7);padding:1.5rem;text-align:center">
      <p style="margin:0 0 4px;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.7)">${esc(tierLabel)} Easer</p>
      <h2 style="margin:0;color:#fff;font-size:1.25rem;font-weight:700">New Job Available</h2>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:0.85rem">Hi ${esc(firstName)} — first to accept gets the job</p>
    </div>
    <div style="padding:1.5rem">
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:1.1rem;margin-bottom:1.25rem">
        <p style="margin:0 0 8px;font-size:1.05rem;font-weight:700;color:#111">${esc(booking.service)}</p>
        <p style="margin:0 0 4px;font-size:0.875rem;color:#374151">Location: ${esc(city)}</p>
        <p style="margin:0 0 4px;font-size:0.875rem;color:#374151">Date: ${esc(booking.date || 'TBD')}${booking.time ? ' · ' + esc(booking.time) : ''}</p>
        ${payEstimate ? `<p style="margin:8px 0 0;font-size:0.95rem;font-weight:700;color:#0097a7">Est. pay: ${payEstimate}</p>` : ''}
      </div>
      <div style="background:#fef9ec;border:1px solid #fbbf24;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.25rem;display:flex;align-items:center;gap:8px">
        <span style="font-size:1rem">⏱</span>
        <span style="font-size:0.85rem;color:#92400e;font-weight:600">Offer expires in ~${expiryMin} minutes</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding-right:6px">
            <a href="${esc(acceptUrl)}" style="display:block;text-align:center;background:#0097a7;color:#fff;padding:13px 20px;border-radius:8px;text-decoration:none;font-size:0.95rem;font-weight:700">Accept Job</a>
          </td>
          <td style="padding-left:6px">
            <a href="${esc(declineUrl)}" style="display:block;text-align:center;background:#f9fafb;color:#6b7280;padding:13px 20px;border-radius:8px;text-decoration:none;font-size:0.95rem;border:1px solid #e5e7eb">Decline</a>
          </td>
        </tr>
      </table>
    </div>
    <div style="padding:0.875rem 1.5rem;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af">
      View all your assignments at <a href="${SITE}/assembler/my-assignments" style="color:#0097a7">AssembleAtEase</a>
    </div>
  </div>
</div></body></html>`;
}
