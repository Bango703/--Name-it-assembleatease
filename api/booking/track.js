import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';

/**
 * POST /api/booking/track
 * Guest booking lookup — no authentication required.
 * Verifies ownership via email + ref (two-factor without a password).
 * Body: { email, ref }
 * Returns sanitized booking fields only (no Stripe IDs, no payment methods).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ok = await rateLimit(ip, 'default');
  if (!ok) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { email, ref } = req.body || {};
  if (!email || !ref) {
    return res.status(400).json({ error: 'Email and booking reference are required.' });
  }

  const sb = getSupabase();
  const { data: booking, error } = await sb
    .from('bookings')
    .select('*')
    .eq('ref', ref.toUpperCase().trim())
    .ilike('customer_email', email.trim())
    .single();

  if (error || !booking) {
    return res.status(404).json({
      error: 'No booking found with that reference and email. Double-check your confirmation email.',
    });
  }

  // Return only safe/public fields — never expose Stripe IDs, phone, raw payment data
  const safe = {
    id: booking.id,
    ref: booking.ref,
    status: booking.status,
    service: booking.service,
    date: booking.date,
    time: booking.time,
    customer_name: booking.customer_name,
    address: booking.address,
    city: booking.city || null,
    total_price: booking.total_price || null,
    deposit_amount: booking.deposit_amount || null,
    payment_status: booking.payment_status || null,
    created_at: booking.created_at,
    cancelled_at: booking.cancelled_at || null,
    completed_at: booking.completed_at || null,
    cancel_reason: booking.cancel_reason || null,
    cancellation_fee: booking.cancellation_fee || null,
  };

  return res.status(200).json({ booking: safe });
}
