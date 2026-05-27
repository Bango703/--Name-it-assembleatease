import { getSupabase } from './_supabase.js';
import { rateLimit } from './_ratelimit.js';
import { logActivity } from './booking/_activity.js';

export default async function handler(req, res) {
  const sb = getSupabase();

  // ── GET — fetch approved reviews for public display ───────────────
  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('reviews')
      .select('id, customer_name, service, rating, body, created_at')
      .eq('approved', true)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      // Log the real error so it appears in Vercel function logs
      console.error('Reviews GET error:', error.code, error.message);
      return res.status(500).json({
        error: 'Failed to fetch reviews',
        detail: error.message, // visible to owner in console, not exposed to public in prod
      });
    }
    return res.status(200).json({ reviews: data || [] });
  }

  // ── POST — submit a new review ────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'default')) return res.status(429).json({ error: 'Too many requests.' });
  } catch (_) {}

  const payload = (req.body && typeof req.body === 'object') ? req.body : {};
  const { ref, email, rating, body } = payload;
  const normalizedRef = String(ref || '').toUpperCase().trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const parsedRating = parseInt(rating, 10);
  if (!ref || !email || !rating || !body) {
    return res.status(400).json({ error: 'Missing required fields: ref, email, rating, body' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (normalizedRef.length < 6) {
    return res.status(400).json({ error: 'Booking reference is invalid.' });
  }
  if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
    return res.status(400).json({ error: 'Rating must be 1-5' });
  }
  if (typeof body !== 'string' || body.trim().length < 10) {
    return res.status(400).json({ error: 'Please write at least a sentence' });
  }

  // Verify booking exists, is completed, and email matches
  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('id, ref, customer_name, service, status, customer_email, assembler_id, assembler_name')
    .eq('ref', normalizedRef)
    .single();

  if (bErr || !booking) {
    return res.status(404).json({ error: 'Booking not found. Check your reference number.' });
  }
  if (!booking.customer_email || booking.customer_email.toLowerCase() !== normalizedEmail) {
    return res.status(403).json({ error: 'Email does not match this booking.' });
  }
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'Reviews can only be left for completed jobs.' });
  }

  // Prevent duplicate reviews — use maybeSingle() so missing row is not an error
  const { data: existing, error: dupErr } = await sb
    .from('reviews')
    .select('id')
    .eq('booking_id', booking.id)
    .maybeSingle();

  if (dupErr) {
    console.error('Duplicate review check error:', dupErr.code, dupErr.message);
    return res.status(500).json({ error: 'Unable to verify review status. Please try again.' });
  }
  if (existing) {
    return res.status(409).json({ error: 'A review has already been submitted for this booking.' });
  }

  // Insert review with transient retry and deterministic duplicate handling.
  // Do not write assembler_id here: some environments may not have that column.
  const reviewRow = {
    booking_id: booking.id,
    customer_name: booking.customer_name,
    service: booking.service,
    rating: parsedRating,
    body: body.trim(),
    approved: true,
  };
  const { error: insErr } = await insertReviewWithRetry(sb, reviewRow, 2);

  if (insErr) {
    if (insErr.code === '23505') {
      return res.status(409).json({ error: 'A review has already been submitted for this booking.' });
    }
    console.error('Review insert error:', insErr.code, insErr.message);
    return res.status(500).json({ error: 'Failed to save review. Please try again.' });
  }

  // Log to booking timeline
  logActivity(sb, {
    bookingId:   booking.id,
    eventType:   'review_submitted',
    actorType:   'customer',
    actorName:   booking.customer_name,
    description: `Customer left a ${parsedRating}-star review`,
    metadata:    { rating: parsedRating },
  });

  // Recalculate Easer's average rating from all their approved reviews
  if (booking.assembler_id) {
    recalcEaserRating(sb, booking.assembler_id).catch(e =>
      console.warn('Rating recalc failed (non-fatal):', e.message)
    );
  }

  return res.status(200).json({ success: true });
}

function isTransientInsertError(error) {
  const transientCodes = new Set(['40001', '40P01', '57P01', '57014']);
  return transientCodes.has(error?.code);
}

async function insertReviewWithRetry(sb, reviewRow, maxAttempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await sb.from('reviews').insert(reviewRow);
    if (!error) return { error: null };
    lastError = error;
    if (!isTransientInsertError(error) || attempt === maxAttempts) break;
    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
  }
  return { error: lastError };
}

/**
 * Recalculate and persist an Easer's average rating and review count.
 * Fetches all approved reviews across all bookings assigned to this Easer.
 * Safe: handles empty booking list, skips update if no reviews found.
 */
async function recalcEaserRating(sb, easerId) {
  // Step 1: get all booking IDs assigned to this Easer
  const { data: easerBookings, error: bErr } = await sb
    .from('bookings')
    .select('id')
    .eq('assembler_id', easerId);

  if (bErr) throw new Error('Booking lookup failed: ' + bErr.message);

  const bookingIds = (easerBookings || []).map(b => b.id);
  if (!bookingIds.length) return; // Easer has no bookings yet — nothing to recalculate

  // Step 2: get all approved reviews for those bookings
  const { data: reviews, error: rErr } = await sb
    .from('reviews')
    .select('rating')
    .eq('approved', true)
    .in('booking_id', bookingIds);

  if (rErr) throw new Error('Review lookup failed: ' + rErr.message);
  if (!reviews?.length) return;

  // Step 3: calculate and persist
  const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
  const { error: uErr } = await sb
    .from('profiles')
    .update({
      rating:       parseFloat(avg.toFixed(1)),
      review_count: reviews.length,
    })
    .eq('id', easerId);

  if (uErr) throw new Error('Profile update failed: ' + uErr.message);
}
