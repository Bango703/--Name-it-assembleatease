import { getSupabase } from '../_supabase.js';
import { rateLimit, rateLimitKey } from '../_ratelimit.js';
import { sendEmail, esc, ownerEmail } from '../_email.js';
import { randomToken, sha256, deriveGuestMutationToken, safeTokenHashMatch } from '../_payment-security.js';
import { bookingEmailMatches } from './_guest-booking-auth.js';

const SITE = 'https://www.assembleatease.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!(await rateLimit(ip, 'booking'))) return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  const ref = String(req.body?.ref || '').trim().toUpperCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !/^AAE-[A-Z0-9-]{6,32}$/.test(ref)) {
    return res.status(200).json({ ok: true, message: 'If those details match a booking, a secure link will be emailed.' });
  }
  if (!(await rateLimitKey(`${ip}:${email}`, 'track_link'))) {
    return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
  }

  const sb = getSupabase();
  const { data: booking } = await sb.from('bookings')
    .select('id, ref, customer_email, customer_name, guest_mutation_token_hash')
    .eq('ref', ref)
    .maybeSingle();

  if (booking && bookingEmailMatches(booking, email)) {
    try {
      // Reuse the token that is already live rather than minting a new one.
      // Rotating on every request meant a second request silently killed the
      // link in the first email, so a customer with two of these in their inbox
      // could only ever open the newest — and clicking the older one requested
      // another, killing the newer. Rotation still happens everywhere it
      // protects something (reschedule, payment recovery); it is not protecting
      // anything here, where the same person just asked for the same link.
      const existingToken = deriveGuestMutationToken({
        bookingId: booking.id,
        ref: booking.ref,
        email: booking.customer_email,
      });
      const reuseExisting = !!booking.guest_mutation_token_hash
        && safeTokenHashMatch(existingToken, booking.guest_mutation_token_hash);

      const token = reuseExisting ? existingToken : randomToken(32);
      const tokenHash = reuseExisting ? booking.guest_mutation_token_hash : sha256(token);
      let tokenUpdate = sb.from('bookings')
        .update({ guest_mutation_token_hash: tokenHash })
        .eq('id', booking.id);
      tokenUpdate = booking.guest_mutation_token_hash == null
        ? tokenUpdate.is('guest_mutation_token_hash', null)
        : tokenUpdate.eq('guest_mutation_token_hash', booking.guest_mutation_token_hash);
      // Reusing writes the same hash back, so a concurrent rotation still loses
      // the compare-and-set and we fall through to the error path as before.
      const { data: updatedTokenRows, error: updateError } = await tokenUpdate.select('id');
      if (updateError || !updatedTokenRows?.length) {
        throw updateError || new Error('The secure booking token changed before a new link could be issued');
      }

      const trackUrl = `${process.env.PUBLIC_SITE_URL || SITE}/track?ref=${encodeURIComponent(booking.ref)}&email=${encodeURIComponent(booking.customer_email)}&token=${encodeURIComponent(token)}`;
      const emailResult = await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        replyTo: ownerEmail(),
        subject: `Your secure booking link - ${booking.ref}`,
        html: `<p>Hi ${esc(String(booking.customer_name || 'there').split(' ')[0])},</p><p>Use the secure link below to view or manage booking <strong>${esc(booking.ref)}</strong>.</p><p><a href="${esc(trackUrl)}">Open secure booking details</a></p><p>If you did not request this, no action is needed.</p>`,
        meta: { bookingId: booking.id, notificationType: 'secure_track_link', recipientType: 'customer', disableDedupe: true },
      });
      // Only roll back a token this call actually replaced. Reusing the live
      // token changed nothing, so there is nothing to undo — and rolling back
      // would write the same value anyway.
      if (!emailResult?.ok && !reuseExisting) {
        await sb.from('bookings')
          .update({ guest_mutation_token_hash: booking.guest_mutation_token_hash })
          .eq('id', booking.id)
          .eq('guest_mutation_token_hash', tokenHash);
      }
    } catch (error) {
      console.error('Secure tracking link request failed:', error);
    }
  }

  return res.status(200).json({ ok: true, message: 'If those details match a booking, a secure link will be emailed.' });
}
