import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, esc, ownerEmail, formatAddress } from '../_email.js';
import { randomToken, sha256, deriveGuestMutationToken, safeTokenHashMatch, guestManageUrl } from '../_payment-security.js';
import { formatAppointmentDate, formatSlotShort, appointmentTimeZone } from '../booking/_appt-date.js';
import { operationalDate, operationalTime } from './_active-jobs.js';
import { logActivity } from '../booking/_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { acquireNotificationLease, releaseNotificationLease, notificationDeliveryKey } from '../_notification-policy.js';

const SITE = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';

const STATUS_PRESENTATION = {
  pending: { label: 'AWAITING CONFIRMATION', color: '#92400e', bg: '#fef3c7' },
  confirmed: { label: 'CONFIRMED', color: '#166534', bg: '#dcfce7' },
  en_route: { label: 'EASER ON THE WAY', color: '#1d4ed8', bg: '#dbeafe' },
  arrived: { label: 'EASER ARRIVED', color: '#1d4ed8', bg: '#dbeafe' },
  in_progress: { label: 'IN PROGRESS', color: '#1d4ed8', bg: '#dbeafe' },
  completed: { label: 'COMPLETED', color: '#166534', bg: '#dcfce7' },
};

/**
 * POST /api/owner/resend-booking-details — the owner sends a customer their
 * booking details and a working tracking link.
 *
 * WHY THIS IS NOT A "RESEND CONFIRMATION"
 * Re-sending the original confirmation would re-state the booking as it was the
 * day it was made — "nothing is charged today", "we're matching you with an
 * Easer" — which can be flatly untrue by the time a customer asks for it again.
 * This sends the booking as it stands right now, which is what the customer
 * actually wants when they call because they cannot find their email.
 *
 * THE LINK ALWAYS WORKS
 * If the deterministic token still matches, it is reused. If it was rotated by
 * a reschedule or a payment recovery, a fresh one is minted and stored under
 * compare-and-set, then handed to guestManageUrl. Either way the customer gets
 * a link that opens their booking rather than a form asking for a code.
 *
 * The URL is also returned so the owner can read it out or paste it into a text
 * while the customer is still on the phone.
 */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String((req.method === 'GET' ? req.query?.bookingId : req.body?.bookingId) || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return res.status(400).json({ error: 'A valid bookingId is required.' });
  }

  const sb = getSupabase();
  const { data: booking, error: loadError } = await sb
    .from('bookings')
    .select('id, ref, status, service, date, time, address, service_city, service_zip, customer_name, customer_email, assembler_name, total_price, guest_mutation_token_hash, return_visit_required, return_visit_date, return_visit_time, return_visit_remaining_scope')
    .eq('id', bookingId)
    .maybeSingle();

  if (loadError) {
    console.error('resend-booking-details load error:', loadError);
    return res.status(503).json({ error: 'The booking could not be read. Nothing was sent.' });
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!booking.customer_email) {
    return res.status(409).json({ error: 'This booking has no customer email address to send to.' });
  }

  const { data: recent, error: historyError } = await sb.from('notification_log')
    .select('id,notification_key,notification_type,channel,status,sent_at,provider_accepted_at,delivered_at')
    .eq('booking_id', booking.id).eq('recipient_type', 'customer')
    .order('sent_at', { ascending: false }).limit(25);
  if (historyError) return res.status(503).json({ error: 'Recent sends could not be checked. Nothing was sent.' });
  const accepted = new Set(['provider_accepted', 'sent', 'delivered', 'delivery_delayed']);
  const details = (recent || []).filter(row => row.notification_type === 'booking_details_resend');
  if (req.method === 'GET') {
    return res.status(200).json({
      recentNotifications: (recent || []).map(row => ({ type: row.notification_type, channel: row.channel,
        status: row.status, createdAt: row.provider_accepted_at || row.sent_at })),
      lastDetailsSentAt: details.find(row => accepted.has(row.status))?.provider_accepted_at
        || details.find(row => accepted.has(row.status))?.sent_at || null,
      lastDetailsDeliveredAt: details.find(row => row.status === 'delivered')?.delivered_at || null,
    });
  }
  const requestId = String(req.body?.requestId || '');
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) return res.status(400).json({ error: 'A unique requestId is required.' });
  const notificationKey = `booking-details:${booking.id}:${requestId}`;
  const deliveryKey = notificationDeliveryKey('email', `customer:${booking.customer_email.trim().toLowerCase()}`, notificationKey);
  const leaseKey = `booking-details:${booking.id}`;
  const lease = await acquireNotificationLease(sb, leaseKey);
  if (!lease.ok) return res.status(409).json({ error: 'Booking details are already being prepared. Wait before retrying.' });
  try {
    // Recheck under the lease, before rotating a guest link. A double click or
    // replay must never invalidate the link in a queued or already-sent email.
    const { data: prior, error: priorError } = await sb.from('notification_log')
      .select('status,notification_key,sent_at,provider_accepted_at,next_attempt_at')
      .eq('booking_id', booking.id).eq('notification_type', 'booking_details_resend')
      .eq('recipient_email', booking.customer_email.trim().toLowerCase())
      .order('sent_at', { ascending: false }).limit(25);
    if (priorError) return res.status(503).json({ error: 'Recent sends could not be verified. Nothing was sent.' });
    const sameRequest = (prior || []).find(row => row.notification_key === deliveryKey);
    const unresolved = (prior || []).find(row => ['queued', 'deferred', 'uncertain'].includes(row.status)
      || (row.status === 'failed' && row.next_attempt_at));
    const veryRecent = (prior || []).find(row => accepted.has(row.status)
      && Date.now() - new Date(row.provider_accepted_at || row.sent_at).getTime() < 120000);
    if (sameRequest || unresolved || veryRecent) {
      const previous = sameRequest || unresolved || veryRecent;
      if (accepted.has(previous.status)) return res.status(200).json({ ok: true, alreadySent: true,
        sentTo: booking.customer_email, message: 'Booking details were already sent. No duplicate email was sent.' });
      return res.status(409).json({ error: `This request is ${previous.status}. Check notification delivery before starting another send.` });
    }

  // A live token, whatever state the booking is in.
  let plainToken = deriveGuestMutationToken({
    bookingId: booking.id, ref: booking.ref, email: booking.customer_email,
  });
  let tokenHash = booking.guest_mutation_token_hash;
  if (!tokenHash || !safeTokenHashMatch(plainToken, tokenHash)) {
    const freshToken = randomToken(32);
    const freshHash = sha256(freshToken);
    let rotate = sb.from('bookings').update({ guest_mutation_token_hash: freshHash }).eq('id', booking.id);
    rotate = booking.guest_mutation_token_hash == null
      ? rotate.is('guest_mutation_token_hash', null)
      : rotate.eq('guest_mutation_token_hash', booking.guest_mutation_token_hash);
    const { data: rotated, error: rotateError } = await rotate.select('id');
    if (rotateError || !rotated?.length) {
      return res.status(409).json({ error: 'The booking changed while preparing the link. Try again.' });
    }
    plainToken = freshToken;
    tokenHash = freshHash;
  }

  const trackUrl = guestManageUrl(
    { ...booking, guest_mutation_token_hash: tokenHash }, SITE, plainToken,
  );

  const presentation = STATUS_PRESENTATION[booking.status]
    || { label: String(booking.status || 'BOOKING').toUpperCase().replace(/_/g, ' '), color: '#3f3f46', bg: '#f4f4f5' };
  const appointmentDate = operationalDate(booking);
  const appointmentTime = operationalTime(booking);
  const timeZone = appointmentTimeZone(booking) === 'America/Denver' ? 'Mountain Time' : 'Central Time';
  const appointmentDateLabel = appointmentDate ? formatAppointmentDate(appointmentDate) : 'To be scheduled';
  const arrivalWindow = appointmentTime ? `${formatSlotShort(appointmentTime)} ${timeZone}` : 'To be scheduled';

  const row = (label, value) => (value
    ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:120px">${esc(label)}</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(value)}</td></tr>`
    : '');

  const emailResult = await sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    replyTo: ownerEmail(),
    subject: `Your booking details — ${booking.ref}`,
    html: buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: presentation.label,
      statusColor: presentation.color,
      statusBg: presentation.bg,
      headline: 'Here are your booking details',
      preheader: `${booking.return_visit_required ? 'Return appointment' : booking.service || 'Your appointment'}: ${appointmentDateLabel}. Arrival window: ${arrivalWindow}.`,
      bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Here are the latest details for your booking. Open your booking link for current updates.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
          ${row('Service', booking.service)}
          ${row(booking.return_visit_required ? 'Return date' : 'Date', appointmentDateLabel)}
          ${row('Arrival window', arrivalWindow)}
          ${row('Address', booking.address ? formatAddress(booking.address) : '')}
          ${row('Your Easer', booking.assembler_name)}
          ${booking.return_visit_required ? row('Remaining work', booking.return_visit_remaining_scope) : ''}
        </table>
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:4px 0 8px">
          <a href="${esc(trackUrl)}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Track my booking</a>
        </td></tr></table>
        <p style="margin:16px 0 0;font-size:13px;color:#71717a;line-height:1.6">Open your booking to see available actions and contact us about any changes.</p>`,
    }),
    meta: {
      bookingId: booking.id,
      notificationType: 'booking_details_resend',
      recipientType: 'customer',
      notificationKey,
    },
  });

  if (!emailResult?.ok) {
    return res.status(503).json({
      error: emailResult?.deferred || emailResult?.retryScheduled
        ? 'The email is queued for another attempt. Do not resend while it is pending.'
        : 'The email was not confirmed sent. Check notification delivery before retrying.',
      trackUrl,
    });
  }

  if (!emailResult.suppressed) await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'booking_details_resent',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Booking details and a tracking link were re-sent to ${booking.customer_email}`,
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    trackUrl,
    sentTo: booking.customer_email,
    alreadySent: Boolean(emailResult.suppressed),
    isTerminal: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.DECLINED].includes(booking.status),
  });
  } finally {
    await releaseNotificationLease(sb, leaseKey, lease.token);
  }
}
