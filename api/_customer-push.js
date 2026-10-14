// Customer app notifications (iPhone, through Firebase Cloud Messaging) and the
// lock-screen tracker (Live Activity) for a booking.
//
// A notification is a doorbell, never the record (Rule 7): every call here
// re-reads the booking, never throws, and a failure only skips the push. The
// words on the tracker are the server's (customerStatusLabel, customerProgress)
// so the lock screen, the app and the booking page say the same thing.

import { sendFcmMessage } from './_native-push.js';
import { customerProgress, customerStatusLabel } from './booking/_customer-status.js';

const BOOKING_FIELDS = 'id, ref, service, status, date, time, customer_id, customer_email, assembler_id, assembler_name, assembler_accepted_at, payment_status, payment_collected, return_visit_required, return_visit_date, return_visit_time';

function missingTable(error) {
  return !!error && (['42P01', 'PGRST205', 'PGRST204'].includes(error.code) || /customer_push_tokens|customer_live_activities|schema cache|does not exist/i.test(String(error.message || '')));
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'Your pro';
}

function windowStart(time) {
  return String(time || '').split(/\s*[-–—]\s*/)[0].trim();
}

/** The words for each moment. Facts and what to do, in the customer's words. */
export function customerPushCopy(event, booking, extra = {}) {
  const pro = firstName(booking.assembler_name);
  const service = booking.service || 'your booking';
  switch (event) {
    case 'accepted':
      return { title: `${pro} is confirmed`, body: `${pro} will handle your ${service}${booking.time ? `, arriving ${windowStart(booking.time)}` : ''}.` };
    case 'en_route':
      return { title: `${pro} is on the way`, body: booking.time ? `Arrival window ${booking.time}.` : 'Your pro is heading to you now.' };
    case 'arrived':
      return { title: `${pro} has arrived`, body: `${pro} is at your location.` };
    case 'in_progress':
      return { title: 'Work has started', body: `${pro} started on your ${service}.` };
    case 'completed':
      return { title: 'Your job is done', body: `Your ${service} is complete. Tap to see the finished work.` };
    case 'time_proposed':
      return { title: `${pro} proposed a new time`, body: 'Accept it or keep your time.' };
    case 'not_home':
      return { title: `${pro} is at your home`, body: `${pro} can't reach you. Reply in the app or call us.` };
    case 'extra_work':
      return { title: 'Extra work needs your OK', body: String(extra.description || 'Open the booking to approve or decline.').slice(0, 140) };
    case 'message': {
      const from = extra.fromName || 'AssembleAtEase';
      const text = String(extra.body || '').replace(/\s+/g, ' ').trim();
      return { title: `Message from ${from}`, body: text.length > 140 ? text.slice(0, 137) + '...' : (text || 'Open the app to read it.') };
    }
    default:
      return null;
  }
}

/** What the lock-screen tracker shows. Keys match BookingActivityAttributes.ContentState. */
export function liveActivityState(booking) {
  const progress = customerProgress(booking);
  return {
    status: customerStatusLabel(booking).label,
    step: progress ? progress.step : 0,
    stepCount: progress ? progress.steps.length : 5,
    proName: booking.assembler_accepted_at ? firstName(booking.assembler_name) : '',
    window: String(booking.time || ''),
  };
}

async function tokensFor(sb, booking) {
  const rows = [];
  const email = String(booking.customer_email || '').trim().toLowerCase();
  const queries = [];
  if (booking.customer_id) queries.push(sb.from('customer_push_tokens').select('token').eq('user_id', booking.customer_id));
  if (email) queries.push(sb.from('customer_push_tokens').select('token').eq('email', email));
  for (const result of await Promise.all(queries)) {
    if (result.error) {
      if (!missingTable(result.error)) console.warn('[customer-push] tokens unreadable:', result.error.message);
      continue;
    }
    rows.push(...(result.data || []));
  }
  return [...new Set(rows.map(r => r.token))];
}

/**
 * Tell the customer's app what just happened on their booking, and move the
 * lock-screen tracker. event: accepted | en_route | arrived | in_progress |
 * completed | cancelled | message. Never throws.
 */
export async function notifyCustomerApp(sb, bookingId, event, extra = {}, deps = {}) {
  try {
    if (!sb || !bookingId) return { sent: 0 };
    const { data: booking, error } = await sb.from('bookings').select(BOOKING_FIELDS).eq('id', bookingId).maybeSingle();
    if (error || !booking) return { sent: 0 };

    let sent = 0;
    const copy = customerPushCopy(event, booking, extra);
    if (copy) {
      const tokens = await tokensFor(sb, booking);
      const dead = [];
      for (const token of tokens) {
        const result = await sendFcmMessage({
          message: {
            token,
            notification: copy,
            data: { ref: String(booking.ref || ''), event: String(event) },
            apns: { payload: { aps: { sound: 'default', 'thread-id': String(booking.ref || '') } } },
          },
        }, deps);
        if (result.ok) sent += 1;
        if (result.gone) dead.push(token);
      }
      if (dead.length) await sb.from('customer_push_tokens').delete().in('token', dead);
    }

    await updateLiveActivities(sb, booking, event, copy, deps);
    return { sent };
  } catch (e) {
    console.warn('[customer-push] skipped:', e?.message || e);
    return { sent: 0 };
  }
}

const ENDS_TRACKER = new Set(['completed', 'cancelled']);

async function updateLiveActivities(sb, booking, event, copy, deps) {
  if (['message', 'time_proposed', 'not_home', 'extra_work'].includes(event)) return;
  const { data: activities, error } = await sb.from('customer_live_activities')
    .select('id, fcm_token, activity_token')
    .eq('booking_id', booking.id)
    .is('ended_at', null);
  if (error) {
    if (!missingTable(error)) console.warn('[customer-push] trackers unreadable:', error.message);
    return;
  }
  if (!activities?.length) return;
  const now = Math.floor(Date.now() / 1000);
  const ending = ENDS_TRACKER.has(event);
  const ended = [];
  for (const activity of activities) {
    const aps = {
      timestamp: now,
      event: ending ? 'end' : 'update',
      'content-state': liveActivityState(booking),
      ...(ending ? { 'dismissal-date': now + 4 * 3600 } : {}),
      ...(copy ? { alert: { title: copy.title, body: copy.body } } : {}),
    };
    const result = await sendFcmMessage({
      message: {
        token: activity.fcm_token,
        apns: {
          live_activity_token: activity.activity_token,
          headers: { 'apns-priority': '10' },
          payload: { aps },
        },
      },
    }, deps);
    if (ending || result.gone) ended.push(activity.id);
  }
  if (ended.length) {
    await sb.from('customer_live_activities').update({ ended_at: new Date().toISOString() }).in('id', ended);
  }
}
