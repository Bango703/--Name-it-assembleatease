import { getSupabase } from '../_supabase.js';
import {
  authenticateBearerUser,
  respondWithEaserAccessError,
} from '../_easer-access.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id')
    .eq('id', authenticated.user.id)
    .eq('role', 'assembler')
    .maybeSingle();
  if (profileError) {
    console.error('[easer-reviews] Profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({
      error: 'Reviews could not be verified right now. Please retry.',
      code: 'REVIEWS_PROFILE_LOOKUP_FAILED',
    });
  }
  if (!profile) return res.status(403).json({ error: 'Easer access required' });

  const { data: bookings, error: bookingError } = await sb.from('bookings')
    .select('id')
    .eq('assembler_id', authenticated.user.id)
    .eq('status', 'completed');
  if (bookingError) {
    console.error('[easer-reviews] Completed booking lookup failed:', bookingError.message || bookingError);
    return res.status(503).json({
      error: 'Reviews could not be loaded right now. Please retry.',
      code: 'REVIEWS_BOOKINGS_UNAVAILABLE',
    });
  }
  const bookingIds = (bookings || []).map(booking => booking.id);
  if (!bookingIds.length) return res.status(200).json({ reviews: [] });

  const { data: reviews, error: reviewError } = await sb.from('reviews')
    .select('id, booking_id, customer_name, rating, body, created_at')
    .in('booking_id', bookingIds)
    .eq('approved', true)
    .order('created_at', { ascending: false });
  if (reviewError) {
    console.error('[easer-reviews] Review lookup failed:', reviewError.message || reviewError);
    return res.status(503).json({
      error: 'Reviews could not be loaded right now. Please retry.',
      code: 'REVIEWS_QUERY_UNAVAILABLE',
    });
  }

  return res.status(200).json({
    reviews: (reviews || []).map(review => ({
      id: review.id,
      rating: review.rating,
      comment: review.body || '',
      customerWouldRehire: false,
      customerFirstName: String(review.customer_name || 'Customer').trim().split(/\s+/)[0],
      createdAt: review.created_at,
    })),
  });
}
