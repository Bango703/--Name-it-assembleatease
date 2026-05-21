import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from './_activity.js';

const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/booking/dispatch
 * Owner-triggered: finds best-matched Easers and sends them a job offer.
 * First to accept gets assigned. Falls back to owner notification if nobody accepts.
 *
 * Dispatch priority:
 *   1. Must be available (is_available = true)
 *   2. Must be in the service area (city match)
 *   3. Rank: Member + Elite > Elite > Member + Verified > Verified > Member + Starter > Starter
 *   4. Tiebreak: proximity (zip) > rating > completed_jobs desc > last_assigned_at asc (fairness)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId required' });

  const sb = getSupabase();

  // Fetch the booking
  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();
  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Only confirmed bookings can be dispatched' });
  if (booking.assembler_id) return res.status(400).json({ error: 'Booking is already assigned to an Easer' });

  // Extract city from booking address for area matching
  const bookingCity = extractCity(booking.address || '');
  const bookingZip  = extractZip(booking.address || '');

  // Fetch all eligible Easers
  const { data: easers } = await sb
    .from('profiles')
    .select('id, full_name, email, phone, city, zip, tier, rating, completed_jobs, has_membership, is_available, last_assigned_at, services_offered')
    .eq('role', 'assembler')
    .eq('status', 'active')
    .eq('identity_verified', true)
    .in('tier', ['starter', 'professional', 'elite']);

  if (!easers || !easers.length) {
    return res.status(200).json({ dispatched: 0, message: 'No eligible Easers found' });
  }

  // Filter: available + area match
  const eligible = easers.filter(function(e) {
    if (!e.is_available) return false;
    if (!e.phone) return false; // phone required for dispatch
    // City match (case-insensitive, partial ok)
    if (bookingCity && e.city) {
      var bc = bookingCity.toLowerCase();
      var ec = (e.city || '').toLowerCase();
      if (!ec.includes(bc) && !bc.includes(ec)) return false;
    }
    return true;
  });

  if (!eligible.length) {
    // No one available locally — notify owner
    return res.status(200).json({ dispatched: 0, message: 'No available Easers in the service area right now' });
  }

  // Score and rank Easers
  const scored = eligible.map(function(e) {
    var score = 0;
    // Tier score (base)
    if (e.tier === 'elite')    score += 300;
    if (e.tier === 'professional') score += 200;
    if (e.tier === 'starter')      score += 100;
    // Membership bonus — applied on top of tier
    if (e.has_membership) score += 150;
    // Proximity bonus (same zip)
    if (bookingZip && e.zip && e.zip === bookingZip) score += 50;
    // Rating bonus (0-50 points)
    if (e.rating) score += Math.round(Number(e.rating) * 10);
    // Experience bonus (max 30 points)
    score += Math.min(30, (e.completed_jobs || 0));
    // Fairness: penalize recently assigned (hours since last job)
    if (e.last_assigned_at) {
      var hoursSince = (Date.now() - new Date(e.last_assigned_at).getTime()) / 3600000;
      score += Math.min(20, Math.round(hoursSince)); // max 20pt bonus after 20+ hours
    } else {
      score += 20; // never assigned — give full fairness bonus
    }
    return Object.assign({}, e, { _score: score });
  });

  scored.sort(function(a, b) { return b._score - a._score; });

  // Send offer to top 3 simultaneously
  const topEasers = scored.slice(0, 3);
  const offerToken = Date.now().toString(36).toUpperCase();

  // Save dispatch record so Easers can accept
  await sb.from('bookings').update({
    dispatch_token: offerToken,
    dispatch_offered_at: new Date().toISOString(),
    dispatch_offered_to: topEasers.map(function(e){ return e.id; }),
  }).eq('id', bookingId);

  var notified = 0;
  for (var i = 0; i < topEasers.length; i++) {
    var easer = topEasers[i];
    var acceptUrl = SITE + '/assembler/my-assignments?accept=' + bookingId + '&token=' + offerToken;

    // Push notification (instant)
    sendPushToUser(easer.id, {
      title: '🔧 Job Offer — Tap to Accept!',
      body:  (booking.service || 'Service') + ' · ' + (booking.date || '') + (booking.time ? ' at ' + booking.time : '') + ' · ' + bookingCity,
      url:   '/assembler/my-assignments?accept=' + bookingId + '&token=' + offerToken,
      jobId: bookingId,
      urgent: true,
    }).catch(function(){});

    // Email backup
    try {
      await sendEmail({
        to: easer.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: '🔧 New Job Available — ' + (booking.service || 'Service') + ' in ' + bookingCity,
        html: buildOfferEmail(easer, booking, bookingCity, acceptUrl),
        replyTo: 'service@assembleatease.com',
      });
      notified++;
    } catch(e) { console.error('Dispatch email error:', e); }
  }

  // Mark booking as dispatched
  await sb.from('bookings').update({ dispatch_status: 'offered' }).eq('id', bookingId);

  const names = topEasers.map(e => e.full_name).join(', ');
  logActivity(sb, { bookingId, eventType: 'dispatched', actorType: 'owner', actorName: 'Owner', description: `Job offered to ${notified} Easer(s): ${names}`, metadata: { dispatched: notified } });

  return res.status(200).json({
    dispatched: notified,
    offeredTo: topEasers.map(function(e){ return { name: e.full_name, tier: e.tier, member: e.has_membership, score: e._score }; }),
  });
}

function extractCity(address) {
  // "615 W 7th St, Austin, TX 78701" -> "Austin"
  var parts = address.split(',');
  if (parts.length >= 2) return parts[parts.length - 2].trim().replace(/\s+\w{2}\s*$/, '').trim();
  return 'Austin';
}

function extractZip(address) {
  var m = address.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

function buildOfferEmail(easer, booking, city, acceptUrl) {
  var firstName = (easer.full_name || 'there').split(' ')[0];
  var memberBadge = easer.has_membership ? '<span style="background:#0097a7;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;margin-left:6px">MEMBER</span>' : '';
  var tierLabel = { starter: 'Starter', professional: 'Professional', elite: 'Elite' }[easer.tier] || easer.tier;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1)">
    <div style="background:linear-gradient(135deg,#0097a7,#005f6b);padding:1.5rem;text-align:center">
      <div style="font-size:2rem;margin-bottom:0.25rem">🔧</div>
      <h2 style="margin:0;color:#fff;font-size:1.3rem">New Job Available!</h2>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:0.85rem">Hi ${esc(firstName)} — you're getting first access${easer.has_membership?' as a member':''}</p>
    </div>
    <div style="padding:1.5rem">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;margin-bottom:1.25rem">
        <tr><td style="padding:1rem">
          <p style="margin:0 0 4px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Job Details</p>
          <p style="margin:0 0 8px;font-size:1.1rem;font-weight:700;color:#111">${esc(booking.service)}</p>
          <p style="margin:0 0 4px;font-size:0.875rem;color:#374151">📍 ${esc(booking.address||city)}</p>
          <p style="margin:0 0 4px;font-size:0.875rem;color:#374151">📅 ${esc(booking.date||'')}${booking.time?' · '+esc(booking.time):''}</p>
          ${booking.total_price?'<p style="margin:4px 0 0;font-size:0.875rem;font-weight:700;color:#0097a7">💰 $'+((booking.total_price||0)/100).toFixed(0)+' job value</p>':''}
        </td></tr>
      </table>
      <p style="margin:0 0 1rem;font-size:0.85rem;color:#6b7280;text-align:center">First to accept gets this job. Act fast!</p>
      <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center">
        <a href="${esc(acceptUrl)}" style="display:inline-block;background:#0097a7;color:#fff;padding:14px 40px;border-radius:10px;text-decoration:none;font-size:1rem;font-weight:700">Accept This Job →</a>
      </td></tr></table>
    </div>
    <div style="padding:1rem 1.5rem;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af">
      You're receiving this because you're a ${esc(tierLabel)} Easer${easer.has_membership?' with an active membership':''}. <a href="${esc(SITE)}/assembler" style="color:#0097a7;text-decoration:none">Open Dashboard</a>
    </div>
  </div>
</div></body></html>`;
}
