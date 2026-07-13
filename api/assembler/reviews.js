import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const authorization = String(req.headers?.authorization || '');
  if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await authClient.auth.getUser(authorization.slice(7));
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const sb = getSupabase();
  const { data: profile } = await sb.from('profiles')
    .select('id')
    .eq('id', user.id)
    .eq('role', 'assembler')
    .maybeSingle();
  if (!profile) return res.status(403).json({ error: 'Easer access required' });

  const { data: bookings, error: bookingError } = await sb.from('bookings')
    .select('id')
    .eq('assembler_id', user.id)
    .eq('status', 'completed');
  if (bookingError) return res.status(500).json({ error: 'Could not load reviews' });
  const bookingIds = (bookings || []).map(booking => booking.id);
  if (!bookingIds.length) return res.status(200).json({ reviews: [] });

  const { data: reviews, error: reviewError } = await sb.from('reviews')
    .select('id, booking_id, customer_name, rating, body, created_at')
    .in('booking_id', bookingIds)
    .eq('approved', true)
    .order('created_at', { ascending: false });
  if (reviewError) return res.status(500).json({ error: 'Could not load reviews' });

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
