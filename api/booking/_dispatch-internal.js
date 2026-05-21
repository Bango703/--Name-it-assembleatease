import { getSupabase } from '../_supabase.js';
import { sendEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';

const SITE = 'https://www.assembleatease.com';

/**
 * Dispatch a confirmed booking to the best available Easers.
 * Called internally — no HTTP request, no auth check.
 * Returns { dispatched, message, offeredTo }
 */
export async function dispatchBooking(bookingId) {
  const sb = getSupabase();

  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();
  if (bErr || !booking) return { dispatched: 0, message: 'Booking not found' };
  if (booking.status !== 'confirmed') return { dispatched: 0, message: 'Booking not confirmed' };
  if (booking.assembler_id) return { dispatched: 0, message: 'Already assigned' };

  const bookingCity = extractCity(booking.address || '');
  const bookingZip  = extractZip(booking.address || '');

  const { data: easers } = await sb
    .from('profiles')
    .select('id, full_name, email, phone, city, zip, tier, rating, completed_jobs, has_membership, is_available, last_assigned_at')
    .eq('role', 'assembler')
    .eq('identity_verified', true)
    .in('tier', ['starter', 'verified', 'elite']);

  if (!easers || !easers.length) return { dispatched: 0, message: 'No eligible Easers' };

  const eligible = easers.filter(e => {
    if (!e.is_available || !e.phone) return false;
    if (bookingCity && e.city) {
      const bc = bookingCity.toLowerCase();
      const ec = (e.city || '').toLowerCase();
      if (!ec.includes(bc) && !bc.includes(ec)) return false;
    }
    return true;
  });

  if (!eligible.length) return { dispatched: 0, message: 'No available Easers in service area' };

  const scored = eligible.map(e => {
    let score = e.tier === 'elite' ? 300 : e.tier === 'verified' ? 200 : 100;
    if (e.has_membership) score += 150;
    if (bookingZip && e.zip && e.zip === bookingZip) score += 50;
    if (e.rating) score += Math.round(Number(e.rating) * 10);
    score += Math.min(30, e.completed_jobs || 0);
    if (e.last_assigned_at) {
      const hrs = (Date.now() - new Date(e.last_assigned_at).getTime()) / 3600000;
      score += Math.min(20, Math.round(hrs));
    } else score += 20;
    return { ...e, _score: score };
  }).sort((a, b) => b._score - a._score);

  const top = scored.slice(0, 3);
  const offerToken = Date.now().toString(36).toUpperCase();

  await sb.from('bookings').update({
    dispatch_token: offerToken,
    dispatch_offered_at: new Date().toISOString(),
    dispatch_offered_to: top.map(e => e.id),
    dispatch_status: 'offered',
  }).eq('id', bookingId);

  let notified = 0;
  for (const easer of top) {
    const acceptUrl = `${SITE}/assembler/my-assignments?accept=${bookingId}&token=${offerToken}`;

    sendPushToUser(easer.id, {
      title: 'New Job Available!',
      body: (booking.service || 'Service') + ' · ' + (booking.date || '') + (booking.time ? ' at ' + booking.time : ''),
      url: `/assembler/my-assignments?accept=${bookingId}&token=${offerToken}`,
      jobId: bookingId,
      urgent: true,
    }).catch(() => {});

    try {
      await sendEmail({
        to: easer.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'New Job Available — ' + (booking.service || 'Service') + ' in ' + bookingCity,
        html: buildOfferEmail(easer, booking, bookingCity, acceptUrl),
        replyTo: 'service@assembleatease.com',
      });
      notified++;
    } catch (e) { console.error('Dispatch email error:', e.message); }
  }

  return {
    dispatched: notified,
    message: notified > 0 ? `Offered to ${notified} Easer(s)` : 'Emails failed',
    offeredTo: top.map(e => ({ name: e.full_name, tier: e.tier, score: e._score })),
  };
}

function extractCity(address) {
  const parts = address.split(',');
  if (parts.length >= 2) return parts[parts.length - 2].trim().replace(/\s+\w{2}\s*$/, '').trim();
  return 'Austin';
}

function extractZip(address) {
  const m = address.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

function buildOfferEmail(easer, booking, city, acceptUrl) {
  const firstName = (easer.full_name || 'there').split(' ')[0];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1)">
    <div style="background:linear-gradient(135deg,#0097a7,#005f6b);padding:1.5rem;text-align:center">
      <h2 style="margin:0;color:#fff;font-size:1.3rem">New Job Available!</h2>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:0.85rem">Hi ${esc(firstName)} — first to accept gets the job</p>
    </div>
    <div style="padding:1.5rem">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;margin-bottom:1.25rem">
        <tr><td style="padding:1rem">
          <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#111">${esc(booking.service)}</p>
          <p style="margin:0 0 4px;font-size:0.875rem;color:#374151">📍 ${esc(booking.address || city)}</p>
          <p style="margin:0;font-size:0.875rem;color:#374151">📅 ${esc(booking.date || '')}${booking.time ? ' at ' + esc(booking.time) : ''}</p>
          ${booking.total_price ? '<p style="margin:6px 0 0;font-size:0.875rem;font-weight:700;color:#0097a7">$' + ((booking.total_price || 0) / 100).toFixed(0) + ' job value</p>' : ''}
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center">
        <a href="${esc(acceptUrl)}" style="display:inline-block;background:#0097a7;color:#fff;padding:14px 40px;border-radius:10px;text-decoration:none;font-size:1rem;font-weight:700">Accept This Job</a>
      </td></tr></table>
    </div>
    <div style="padding:1rem 1.5rem;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af">
      Open your <a href="${SITE}/assembler/" style="color:#0097a7">Easer Dashboard</a> to manage your assignments.
    </div>
  </div>
</div></body></html>`;
}
