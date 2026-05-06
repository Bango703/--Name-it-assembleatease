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
    .select(
      'id, ref, status, service, date, time, customer_name, address, city, total_price, deposit_amount, payment_status, created_at, cancelled_at, completed_at, cancel_reason, cancellation_fee'
    )
    .eq('ref', ref.toUpperCase().trim())
    .ilike('customer_email', email.trim())
    .single();

  if (error || !booking) {
    return res.status(404).json({
      error: 'No booking found with that reference and email. Check your confirmation email.',
    });
  }

  return res.status(200).json({ booking });
}
