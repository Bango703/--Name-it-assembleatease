import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * GET /api/booking/dispatch-log?bookingId={id}
 * Owner-only: returns dispatch offer history for a booking.
 * Includes Easer name, tier, score, offer status, and timestamps.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId } = req.query;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();

  // Fetch all offers for this booking, joined with Easer profile
  const { data: offers, error } = await sb
    .from('dispatch_offers')
    .select('id, easer_id, dispatch_score, offer_status, token, attempt_number, sent_at, expires_at, accepted_at, declined_at, timed_out_at, decline_reason, notification_sent, created_at')
    .eq('booking_id', bookingId)
    .order('attempt_number', { ascending: true })
    .order('dispatch_score', { ascending: false });

  if (error) {
    console.error('dispatch-log error:', error);
    return res.status(500).json({ error: 'Failed to fetch dispatch log' });
  }

  if (!offers?.length) {
    return res.status(200).json({ offers: [], summary: { totalOffers: 0, attempts: 0 } });
  }

  // Enrich with Easer profiles
  const easerIds = [...new Set(offers.map(o => o.easer_id))];
  const { data: profiles } = await sb
    .from('profiles')
    .select('id, full_name, tier, rating, completed_jobs, has_membership')
    .in('id', easerIds);

  const profileMap = {};
  (profiles || []).forEach(p => { profileMap[p.id] = p; });

  const enriched = offers.map(o => {
    const p = profileMap[o.easer_id] || {};
    const now = new Date();
    const sentAt = new Date(o.sent_at);
    const responseTime = o.accepted_at
      ? Math.round((new Date(o.accepted_at) - sentAt) / 60000) + ' min'
      : o.declined_at
        ? Math.round((new Date(o.declined_at) - sentAt) / 60000) + ' min'
        : o.timed_out_at
          ? 'timed out'
          : o.expires_at && new Date(o.expires_at) > now
            ? `expires in ${Math.max(0, Math.round((new Date(o.expires_at) - now) / 60000))} min`
            : 'pending';

    return {
      id:              o.id,
      attempt:         o.attempt_number,
      easer_id:        o.easer_id,
      easer_name:      p.full_name || 'Unknown',
      easer_tier:      p.tier || '—',
      easer_rating:    p.rating || null,
      easer_jobs:      p.completed_jobs || 0,
      easer_member:    p.has_membership || false,
      dispatch_score:  o.dispatch_score,
      offer_status:    o.offer_status,
      notification_sent: o.notification_sent,
      sent_at:         o.sent_at,
      expires_at:      o.expires_at,
      accepted_at:     o.accepted_at,
      declined_at:     o.declined_at,
      timed_out_at:    o.timed_out_at,
      decline_reason:  o.decline_reason,
      response_time:   responseTime,
    };
  });

  const maxAttempt = Math.max(...offers.map(o => o.attempt_number));
  const accepted   = offers.find(o => o.offer_status === 'accepted');

  return res.status(200).json({
    offers: enriched,
    summary: {
      totalOffers: offers.length,
      attempts: maxAttempt,
      accepted: !!accepted,
      acceptedBy: accepted ? profileMap[accepted.easer_id]?.full_name : null,
    },
  });
}
