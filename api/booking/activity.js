import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();

  if (req.method === 'GET') {
    const { bookingId } = req.query;
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });

    // Fetch activity events and notification log in parallel
    const [activityRes, notifRes] = await Promise.all([
      sb.from('activity_logs')
        .select('*')
        .eq('booking_id', bookingId)
        .order('created_at', { ascending: true }),
      sb.from('notification_log')
        .select('id, channel, notification_type, recipient_type, recipient_email, subject, status, error_text, sent_at')
        .eq('booking_id', bookingId)
        .order('sent_at', { ascending: true }),
    ]);

    if (activityRes.error) return res.status(500).json({ error: 'Failed to load activity: ' + activityRes.error.message });

    // Normalise notification_log rows into the same shape as activity_log rows
    const notifEvents = (notifRes.data || []).map(n => ({
      id:          n.id,
      booking_id:  bookingId,
      event_type:  n.status === 'failed' ? 'notification_failed' : (n.status === 'suppressed' ? 'notification_suppressed' : 'notification_sent'),
      actor_type:  n.channel,           // 'email' | 'push'
      actor_name:  n.channel === 'email' ? 'Email' : 'Push',
      description: formatNotifDescription(n),
      metadata:    {
        status: n.status,
        error: n.error_text,
        notificationType: n.notification_type,
        recipientType: n.recipient_type,
        recipientEmail: n.recipient_email,
        ownerAction: n.status === 'failed' ? 'Confirm the booking state, then contact the intended recipient using the booking record.' : null,
      },
      created_at:  n.sent_at,
      _source:     'notification',
      _status:     n.status,            // 'sent' | 'failed' — used for dot color in UI
    }));

    // Merge and sort by timestamp
    const all = [...(activityRes.data || []), ...notifEvents]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    return res.status(200).json({
      activity: all,
      partial: Boolean(notifRes.error),
      warning: notifRes.error ? 'Notification history could not be loaded.' : null,
    });
  }

  if (req.method === 'POST') {
    const { bookingId, description, eventType = 'owner_action', metadata } = req.body;
    if (!bookingId || !description) return res.status(400).json({ error: 'bookingId and description required' });

    const { error } = await sb.from('activity_logs').insert({
      booking_id: bookingId,
      event_type: eventType,
      actor_type: 'owner',
      actor_name: 'Owner',
      description,
      metadata: metadata || null,
    });

    if (error) return res.status(500).json({ error: 'Failed to log activity: ' + error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function formatNotifDescription(n) {
  const typeLabels = {
    booking_created:          'Booking created',
    booking_confirmed:        'Booking confirmation email',
    dispatch_offer:           'Job offer sent to Easer',
    assignment_confirmation:  'Assignment confirmation to Easer',
    job_accepted:             'Easer confirmed — customer notified',
    en_route:                 'Easer on the way — customer notified',
    arrived:                  'Easer arrived — customer notified',
    in_progress:              'Job started — customer notified',
    completion:               'Completion receipt sent',
    payment_receipt:          'Payment receipt sent',
    cancellation:             'Cancellation notification sent',
    review_request:           'Review request sent',
    reminder:                 'Appointment reminder sent',
    payout_summary:           'Payout summary sent',
    reschedule_customer:      'Reschedule confirmation to customer',
    reschedule_owner:         'Reschedule alert to owner',
    reschedule_easer_reconfirmation: 'Reschedule acceptance request to Easer',
    damage_claim_reported:    'Damage report alert to owner',
    cron_alert:               'System alert',
    transactional:            'Email notification',
  };
  const recipientLabels = {
    customer: 'customer',
    easer:    'Easer',
    owner:    'owner',
  };
  const label = typeLabels[n.notification_type] || n.notification_type;
  const to    = recipientLabels[n.recipient_type] || n.recipient_type || '';
  const via   = n.channel === 'push' ? 'push notification' : 'email';

  if (n.status === 'failed') {
    return `${label} ${via} to ${to} FAILED — ${n.error_text || 'unknown error'}`;
  }
  if (n.status === 'suppressed') {
    return `${label} ${via} to ${to} suppressed — ${n.error_text || 'duplicate or delivery cap'}`;
  }
  const recipient = n.recipient_email || to;
  return `${label} sent via ${via} to ${recipient}`;
}
