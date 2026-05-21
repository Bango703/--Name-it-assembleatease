import { getSupabase } from './_supabase.js';
import { rateLimit } from './_ratelimit.js';

export default async function handler(req, res) {
  const sb = getSupabase();

  // ── GET — fetch approved reviews for display ──────────────────────
  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('reviews')
      .select('id, customer_name, service, rating, body, created_at')
      .eq('approved', true)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: 'Failed to fetch reviews' });
    return res.status(200).json({ reviews: data || [] });
  }

  // ── POST — submit a new review ────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'default')) return res.status(429).json({ error: 'Too many requests.' });
  } catch (_) {}

  const { ref, email, rating, body } = req.body;
  if (!ref || !email || !rating || !body) return res.status(400).json({ error: 'Missing required fields' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
  if (body.trim().length < 10) return res.status(400).json({ error: 'Please write at least a sentence' });

  // Verify the booking exists, is completed, and email matches
  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('id, customer_name, service, status, customer_email')
    .eq('ref', ref.toUpperCase())
    .single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found. Check your reference number.' });
  if (booking.customer_email.toLowerCase() !== email.toLowerCase()) return res.status(403).json({ error: 'Email does not match this booking.' });
  if (booking.status !== 'completed') return res.status(400).json({ error: 'Reviews can only be left for completed jobs.' });

  // Prevent duplicate reviews for the same booking
  const { data: existing } = await sb.from('reviews').select('id').eq('booking_id', booking.id).single();
  if (existing) return res.status(409).json({ error: 'A review has already been submitted for this booking.' });

  const { error: insErr } = await sb.from('reviews').insert({
    booking_id:    booking.id,
    customer_name: booking.customer_name,
    service:       booking.service,
    rating:        parseInt(rating),
    body:          body.trim(),
    approved:      true,
  });

  if (insErr) {
    console.error('Review insert error:', insErr);
    return res.status(500).json({ error: 'Failed to save review. Please try again.' });
  }

  // Update Easer's average rating on their profile
  try {
    const { data: bookingFull } = await sb.from('bookings').select('assembler_id').eq('id', booking.id).single();
    if (bookingFull?.assembler_id) {
      const { data: allReviews } = await sb
        .from('reviews')
        .select('rating')
        .eq('approved', true)
        .in('booking_id',
          (await sb.from('bookings').select('id').eq('assembler_id', bookingFull.assembler_id)).data?.map(b => b.id) || []
        );
      if (allReviews?.length) {
        const avg = allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length;
        await sb.from('profiles').update({
          rating: Math.round(avg * 10) / 10,
          review_count: allReviews.length,
        }).eq('id', bookingFull.assembler_id);
      }
    }
  } catch(e) { console.warn('Rating update failed (non-fatal):', e.message); }

  return res.status(200).json({ success: true });
}
