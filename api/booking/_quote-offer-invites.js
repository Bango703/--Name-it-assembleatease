// Asking Easers for their price on a custom quote. The rules live in
// api/booking/_quote-offers.js; this file reads and writes and sends.

import { findEligibleEasers } from './_dispatch-internal.js';
import { loadBookingItems } from './_booking-items.js';
import { isQuoteAwaitingPrice } from './_quote-state.js';
import { logActivity } from './_activity.js';
import { formatAppointmentDate, formatAppointmentDateShort } from './_appt-date.js';
import { sendEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { sendSms } from '../_sms.js';
import { isMissingTableError } from '../_promotions.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';
import {
  QUOTE_OFFER_STATUS,
  QUOTE_OFFER_RESPONSE_HOURS,
  QUOTE_OFFER_MAX_INVITES,
  customerQuoteForEarnings,
  quoteRequestForEaser,
} from './_quote-offers.js';

const SITE = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';
export const PRICE_REQUESTS_URL = `${SITE}/assembler/price-requests`;

/** A quote can take Easer prices while it is waiting for the owner's price. */
export function quoteAcceptsOffers(booking = {}) {
  if (booking.selected_quote_offer_id || booking.quote_approved_at || booking.stripe_payment_intent_id) return false;
  if (isQuoteAwaitingPrice(booking)) return true;
  // A sent quote the customer has not started approving can be repriced.
  return booking.status === 'pending' && booking.payment_status === 'quote_pending_approval'
    && !booking.quote_approved_at && !booking.stripe_payment_intent_id;
}

/** Every offer on a booking, with the Easer and, when priced, the customer quote. */
export async function loadQuoteOffersForOwner(sb, bookingId) {
  const { data: offers, error } = await sb.from('quote_price_offers')
    .select('id, easer_id, status, earnings_cents, hours, crew_size, note, invited_at, respond_by, submitted_at, decided_at, updated_at')
    .eq('booking_id', bookingId)
    .order('invited_at', { ascending: true });
  if (error) {
    if (isMissingTableError(error)) return { offers: [], migrationNeeded: true };
    throw error;
  }
  const easerIds = [...new Set((offers || []).map(o => o.easer_id))];
  const profiles = new Map();
  if (easerIds.length) {
    const { data: rows, error: profileError } = await sb.from('profiles')
      .select('id, full_name, rating, completed_jobs, tier, has_membership, city')
      .in('id', easerIds);
    if (profileError) throw profileError;
    (rows || []).forEach(row => profiles.set(row.id, row));
  }
  const now = Date.now();
  return {
    offers: (offers || []).map(offer => {
      const easer = profiles.get(offer.easer_id) || {};
      const priced = offer.earnings_cents > 0
        ? customerQuoteForEarnings(offer.earnings_cents, { isMember: hasEffectiveEaserMembership(easer) })
        : null;
      return {
        id: offer.id,
        status: offer.status,
        open: [QUOTE_OFFER_STATUS.INVITED, QUOTE_OFFER_STATUS.SUBMITTED].includes(offer.status) && Date.parse(offer.respond_by) > now,
        easer: {
          id: offer.easer_id,
          name: easer.full_name || 'Easer',
          rating: easer.rating != null ? Number(easer.rating) : null,
          completedJobs: Number(easer.completed_jobs || 0),
          tier: easer.tier || null,
          city: easer.city || null,
        },
        earningsCents: offer.earnings_cents,
        hours: offer.hours != null ? Number(offer.hours) : null,
        crewSize: offer.crew_size,
        note: offer.note,
        invitedAt: offer.invited_at,
        respondBy: offer.respond_by,
        submittedAt: offer.submitted_at,
        updatedAt: offer.updated_at,
        customerQuote: priced ? {
          subtotalCents: priced.subtotalCents,
          taxCents: priced.taxCents,
          totalCents: priced.totalCents,
          platformFeeCents: priced.platformFeeCents,
        } : null,
      };
    }),
    migrationNeeded: false,
  };
}

/**
 * Invite the Easers who could be offered this job and have not been asked yet.
 * Highest rated and most experienced first, at most QUOTE_OFFER_MAX_INVITES in
 * all. Returns {invited, message} where message says why nobody was asked.
 */
/**
 * The Easers the owner can still ask on this quote: eligible for the job
 * (findEligibleEasers, the dispatch rule) and not asked yet, best rated and
 * most experienced first. The owner's dashboard lists exactly these.
 * @returns {Promise<{easers: object[], asked: number, room: number, message: string|null}>}
 */
export async function listAskableEasers(sb, booking) {
  const found = await findEligibleEasers(sb, booking);
  const { data: existing, error: existingError } = await sb.from('quote_price_offers')
    .select('easer_id').eq('booking_id', booking.id);
  if (existingError) throw existingError;
  const asked = new Set((existing || []).map(row => row.easer_id));
  const room = Math.max(0, QUOTE_OFFER_MAX_INVITES - asked.size);
  const easers = (found.easers || [])
    .filter(easer => !asked.has(easer.id))
    .sort((a, b) => (Number(b.rating || 0) - Number(a.rating || 0)) || (Number(b.completed_jobs || 0) - Number(a.completed_jobs || 0)));
  let message = null;
  if (!found.easers.length) message = found.message || 'No Easer can be offered this job.';
  else if (room <= 0) message = `${QUOTE_OFFER_MAX_INVITES} Easers have already been asked on this quote.`;
  else if (!easers.length) message = 'Every Easer who covers this area has already been asked.';
  return { easers, asked: asked.size, room, message };
}

/** What the owner's list shows for one askable Easer. Never contact details. */
export function askableEaserView(easer = {}) {
  return {
    id: easer.id,
    name: easer.full_name || 'Easer',
    rating: easer.rating != null ? Number(easer.rating) : null,
    completedJobs: Number(easer.completed_jobs || 0),
    tier: easer.tier || null,
    city: easer.city || null,
  };
}

/**
 * Which Easers to ask, from the owner's ticks. Every tick must still be
 * askable: the server re-checks, so a stale list or a hand-made request can
 * never reach an Easer who is not eligible. No ticks (null) asks everyone
 * askable, up to the room left on the quote.
 * @returns {{chosen: object[], message: string|null}}
 */
export function chooseEasersToAsk(askableEasers = [], easerIds = null, room = QUOTE_OFFER_MAX_INVITES) {
  let chosen = askableEasers;
  if (Array.isArray(easerIds)) {
    const wanted = new Set(easerIds.map(String));
    chosen = askableEasers.filter(easer => wanted.has(String(easer.id)));
    if (!chosen.length) return { chosen: [], message: 'None of the chosen Easers can be asked on this quote. Refresh the list.' };
    if (chosen.length < wanted.size) return { chosen: [], message: 'One of the chosen Easers can no longer be asked on this quote. Refresh the list and choose again.' };
    if (chosen.length > room) return { chosen: [], message: `Only ${room} more Easer${room === 1 ? '' : 's'} can be asked on this quote. Untick some and try again.` };
  }
  return { chosen: chosen.slice(0, room), message: null };
}

/** Ask Easers for their price: the owner's ticks, or everyone askable. */
export async function inviteEasersForQuote(sb, booking, { easerIds = null } = {}) {
  const askable = await listAskableEasers(sb, booking);
  if (askable.message) return { invited: 0, message: askable.message };
  const picked = chooseEasersToAsk(askable.easers, easerIds, askable.room);
  if (picked.message) return { invited: 0, message: picked.message };
  const fresh = picked.chosen;

  const now = new Date();
  const respondBy = new Date(now.getTime() + QUOTE_OFFER_RESPONSE_HOURS * 3600000).toISOString();
  const { data: inserted, error: insertError } = await sb.from('quote_price_offers')
    .insert(fresh.map(easer => ({ booking_id: booking.id, easer_id: easer.id, status: QUOTE_OFFER_STATUS.INVITED, respond_by: respondBy })))
    .select('id, easer_id, respond_by, status, earnings_cents');
  if (insertError) {
    if (insertError.code === '23505') return { invited: 0, message: 'These Easers were asked a moment ago. Refresh the offers.' };
    throw insertError;
  }
  await sb.from('bookings').update({ quote_offers_requested_at: now.toISOString() }).eq('id', booking.id);

  const groups = (await loadBookingItems([booking.id], { sb }).catch(() => new Map())).get(booking.id) || [];
  const byEaser = new Map(fresh.map(easer => [easer.id, easer]));
  let notified = 0;
  for (const offer of inserted || []) {
    const easer = byEaser.get(offer.easer_id);
    if (!easer) continue;
    const delivered = await notifyEaserOfPriceRequest(easer, booking, offer, groups);
    if (delivered) notified++;
  }
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'quote_offers_requested',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Asked ${fresh.length} Easer${fresh.length === 1 ? '' : 's'} for a price (${notified} reached)`,
    metadata: { easerIds: fresh.map(e => e.id), respondBy, notified },
  });
  return { invited: fresh.length, notified, respondBy, message: null };
}

/**
 * The words of the price-approved notice. The amount is what the Easer asked
 * to be paid (offer.earnings_cents), never the customer's quote (Rule 3).
 */
export function priceApprovedNotice(booking = {}, offer = {}, fullName = '') {
  const dollars = Number(offer.earnings_cents || 0) / 100;
  const amount = '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2, maximumFractionDigits: 2 });
  const service = booking.service || 'Custom job';
  const day = booking.date ? formatAppointmentDateShort(booking.date) : '';
  const firstName = String(fullName || 'there').split(' ')[0] || 'there';
  return {
    sms: `AssembleAtEase: your ${amount} price for ${service}${day ? ' on ' + day : ''} was approved and sent to the customer. When they approve, the job is offered to you first. Ref ${booking.ref}: ${PRICE_REQUESTS_URL}`,
    pushTitle: 'Price approved',
    pushBody: `Your ${amount} price for ${service} was sent to the customer.`,
    subject: `Your price was approved: ${service} (${booking.ref})`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:1.5rem">
        <p>Hi ${esc(firstName)},</p>
        <p>Your price of <strong>${esc(amount)}</strong> for ${esc(service)}${day ? ' on ' + esc(day) : ''} was approved. We sent the customer the quote.</p>
        <p>When the customer approves, the job is offered to you first. Accept it in the app.</p>
        <p><a href="${PRICE_REQUESTS_URL}" style="display:inline-block;background:#00BFFF;color:#001f2b;padding:0.7rem 1.2rem;border-radius:8px;font-weight:700;text-decoration:none">View the request</a></p>
        <p style="font-size:13px;color:#71717a">Ref ${esc(booking.ref)}<br>The AssembleAtEase Team</p>
      </div>`,
  };
}

/**
 * The Easer whose price the owner approved is told at once (owner, 2026-11-13:
 * "they need to get a text once their bid amount is approved"). Text, push and
 * email, like the price request, so an Easer without text consent still hears.
 * Called after the quote is saved; it never throws and never changes the quote.
 * When the customer approves, dispatch offers the job to this Easer first and
 * sends its own job-offer text, so that moment needs no second message here.
 */
export async function notifyEaserPriceApproved(sb, booking, offer) {
  try {
    const { data: easer, error } = await sb.from('profiles')
      .select('id, full_name, email, phone, sms_consent_at, sms_opted_out_at')
      .eq('id', offer.easer_id).maybeSingle();
    if (error || !easer) return { reached: false, channels: [], reason: 'easer_not_found' };
    const msg = priceApprovedNotice(booking, offer, easer.full_name);
    // One notice per offer, however many times the quote is re-sent with it.
    const meta = { bookingId: booking.id, notificationType: 'quote_price_approved', recipientType: 'easer', recipientUserId: easer.id, notificationKey: `quote-price-approved:${offer.id}` };
    const [sms, push, email] = await Promise.all([
      sendSms({ recipient: easer, body: msg.sms, meta })
        .catch(err => ({ ok: false, error: err?.message || String(err) })),
      sendPushToUser(easer.id, { title: msg.pushTitle, body: msg.pushBody, url: PRICE_REQUESTS_URL }, meta)
        .catch(err => ({ ok: false, error: err?.message || String(err) })),
      sendEmail({ to: easer.email, subject: msg.subject, html: msg.html, replyTo: 'service@assembleatease.com', meta })
        .catch(err => ({ ok: false, error: err?.message || String(err) })),
    ]);
    const channels = [];
    if (sms?.ok) channels.push('text');
    if (push?.ok) channels.push('push');
    if (email?.ok && !email?.suppressed) channels.push('email');
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'quote_price_approved_notice',
      actorType: 'system',
      actorName: 'System',
      description: channels.length
        ? `Easer told their price was approved (${channels.join(', ')})`
        : 'Easer could not be told their price was approved',
      metadata: { quoteOfferId: offer.id, easerId: easer.id, channels, smsSkipped: sms?.skipped || null },
    }).catch(() => {});
    return { reached: channels.length > 0, channels, smsSkipped: sms?.skipped || null };
  } catch (err) {
    console.error('price approved notice failed:', err?.message || err);
    return { reached: false, channels: [], reason: 'notice_failed' };
  }
}

async function notifyEaserOfPriceRequest(easer, booking, offer, groups) {
  const request = quoteRequestForEaser(offer, booking, groups);
  const firstName = String(easer.full_name || 'there').split(' ')[0];
  const where = [request.city, request.zip].filter(Boolean).join(' ') || 'Texas';
  const when = request.date ? formatAppointmentDate(request.date) + (request.time ? `, ${request.time}` : '') : 'Date to be agreed';
  const respondBy = new Date(offer.respond_by).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const key = `quote-price-request:${booking.id}:${easer.id}`;
  const itemsHtml = request.items.length
    ? `<ul style="padding-left:1.1rem;margin:0.4rem 0">${request.items.slice(0, 12).map(i => `<li>${esc(i.name)}${i.quantity > 1 ? ' x' + i.quantity : ''}</li>`).join('')}</ul>`
    : '';
  const meta = { bookingId: booking.id, notificationType: 'quote_price_request', recipientType: 'easer', recipientUserId: easer.id, notificationKey: key };

  const results = await Promise.all([
    sendEmail({
      to: easer.email,
      subject: `Price request: ${booking.service || 'Custom job'} in ${where} (${booking.ref})`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:1.5rem">
        <p>Hi ${esc(firstName)},</p>
        <p>We have a custom job and would like your price.</p>
        <p><strong>${esc(booking.service || 'Custom job')}</strong><br>${esc(where)}<br>${esc(when)}</p>
        ${itemsHtml}
        ${request.details ? `<p style="color:#52525b">${esc(request.details.slice(0, 600))}</p>` : ''}
        <p>Enter what you want to earn, the hours and your crew by <strong>${esc(respondBy)}</strong>. Your price is private.</p>
        <p><a href="${PRICE_REQUESTS_URL}" style="display:inline-block;background:#00BFFF;color:#001f2b;padding:0.7rem 1.2rem;border-radius:8px;font-weight:700;text-decoration:none">Enter your price</a></p>
        <p style="font-size:13px;color:#71717a">The AssembleAtEase Team</p>
      </div>`,
      replyTo: 'service@assembleatease.com',
      meta,
    }).catch(error => ({ ok: false, error: error?.message || String(error) })),
    sendPushToUser(easer.id, {
      title: 'Price request',
      body: `${booking.service || 'Custom job'} in ${where}. Enter your price by ${respondBy}.`,
      url: PRICE_REQUESTS_URL,
    }, meta).catch(error => ({ ok: false, error: error?.message || String(error) })),
    sendSms({
      recipient: { ...easer, sms_consent_at: easer.sms_consent_at, sms_opted_out_at: easer.sms_opted_out_at },
      body: `AssembleAtEase price request: ${booking.service || 'Custom job'} in ${request.city || 'your area'}${request.date ? ' ' + formatAppointmentDateShort(request.date) : ''}. Enter your price by ${respondBy}: ${PRICE_REQUESTS_URL}`,
      meta,
    }).catch(error => ({ ok: false, error: error?.message || String(error) })),
  ]);
  return results.some(r => r?.ok && !r?.suppressed);
}
