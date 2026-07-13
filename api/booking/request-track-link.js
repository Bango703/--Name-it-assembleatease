import { getSupabase } from '../_supabase.js';
import { rateLimit, rateLimitKey } from '../_ratelimit.js';
import { sendEmail, esc, ownerEmail } from '../_email.js';
import { deriveGuestMutationToken, guestMutationTokenHash } from '../_payment-security.js';

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
    .ilike('customer_email', email)
    .maybeSingle();

  if (booking) {
    try {
      const token = deriveGuestMutationToken({ bookingId: booking.id, ref: booking.ref, email: booking.customer_email });
      const tokenHash = guestMutationTokenHash(booking);
      const { error: updateError } = await sb.from('bookings')
        .update({ guest_mutation_token_hash: tokenHash })
        .eq('id', booking.id);
      if (updateError) throw updateError;

      const trackUrl = `${process.env.PUBLIC_SITE_URL || SITE}/track?ref=${encodeURIComponent(booking.ref)}&email=${encodeURIComponent(booking.customer_email)}&token=${encodeURIComponent(token)}`;
      const emailResult = await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        replyTo: ownerEmail(),
        subject: `Your secure booking link - ${booking.ref}`,
        html: `<p>Hi ${esc(String(booking.customer_name || 'there').split(' ')[0])},</p><p>Use the secure link below to view or manage booking <strong>${esc(booking.ref)}</strong>.</p><p><a href="${esc(trackUrl)}">Open secure booking details</a></p><p>If you did not request this, no action is needed.</p>`,
        meta: { bookingId: booking.id, notificationType: 'secure_track_link', recipientType: 'customer', disableDedupe: true },
      });
      if (!emailResult?.ok) {
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
