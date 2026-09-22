import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, esc, ownerEmail } from '../_email.js';
import { randomToken, sha256, deriveGuestMutationToken, safeTokenHashMatch, guestManageUrl } from '../_payment-security.js';
import { formatAppointmentDate } from '../booking/_appt-date.js';
import { logActivity } from '../booking/_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return res.status(400).json({ error: 'A valid bookingId is required.' });
  }

  const sb = getSupabase();
  const { data: booking, error: loadError } = await sb
    .from('bookings')
    .select('id, ref, status, service, date, time, address, customer_name, customer_email, assembler_name, total_price, guest_mutation_token_hash')
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
      preheader: `${booking.service || 'Your appointment'} on ${formatAppointmentDate(booking.date)}`,
      bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">You asked for these again, so here they are. Everything below is current as of today.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
          ${row('Service', booking.service)}
          ${row('Date', formatAppointmentDate(booking.date))}
          ${row('Time', booking.time)}
          ${row('Address', booking.address)}
          ${row('Your Easer', booking.assembler_name)}
        </table>
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:4px 0 8px">
          <a href="${esc(trackUrl)}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Track my booking</a>
        </td></tr></table>
        <p style="margin:16px 0 0;font-size:13px;color:#71717a;line-height:1.6">That link opens your booking, where you can message us, send a photo, or reschedule.</p>`,
    }),
    meta: {
      bookingId: booking.id,
      notificationType: 'booking_details_resend',
      recipientType: 'customer',
      disableDedupe: true,
    },
  });

  if (!emailResult?.ok || emailResult?.suppressed) {
    return res.status(503).json({
      error: emailResult?.suppressed
        ? 'That address is suppressed, so the email was not sent. Read the tracking link to the customer instead.'
        : 'The email could not be sent. The tracking link below still works.',
      trackUrl,
    });
  }

  await logActivity(sb, {
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
    isTerminal: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.DECLINED].includes(booking.status),
  });
}
