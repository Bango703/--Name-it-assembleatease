import { customerUnavailableState } from './_easer-support.js';
import { loadChangeOrders, CHANGE_ORDER_STATUS } from './_change-orders.js';
import { summarizeTips } from '../assembler/_easer-tips.js';

/**
 * What an Easer sees on a job beyond the booking row (owner audit, 2026-10-12):
 * the customer-not-home clock, the time a reschedule moved from, their tip, the
 * time they proposed, the extra work they asked for, and whether they rated the
 * customer. Each source is read on its own and fails soft: a table that is not
 * there yet (migration 110) or a slow query leaves that field empty and never
 * blocks the job list.
 */
export async function loadEaserJobExtras(sb, bookings, easerId, nowMs = Date.now()) {
  const extras = new Map();
  const ids = (bookings || []).map(b => b.id).filter(Boolean);
  if (!ids.length || !easerId) return extras;
  const get = id => {
    if (!extras.has(id)) extras.set(id, {});
    return extras.get(id);
  };

  // Activity: reschedules and the customer-not-home flow.
  try {
    const { data, error } = await sb.from('activity_logs')
      .select('booking_id, event_type, created_at, metadata')
      .in('booking_id', ids)
      .in('event_type', ['rescheduled', 'customer_unavailable_reported', 'customer_no_show_reported'])
      .order('created_at', { ascending: false });
    if (!error) {
      const byBooking = new Map();
      (data || []).forEach(row => {
        if (!byBooking.has(row.booking_id)) byBooking.set(row.booking_id, []);
        byBooking.get(row.booking_id).push(row);
      });
      for (const [bookingId, rows] of byBooking) {
        const unavailable = customerUnavailableState(rows, nowMs);
        if (unavailable) get(bookingId).customerUnavailable = unavailable;
        const moved = rows.find(r => r.event_type === 'rescheduled');
        if (moved?.metadata?.oldDate) {
          get(bookingId).previousSlot = { date: moved.metadata.oldDate, time: moved.metadata.oldTime || null, changedAt: moved.created_at };
        }
      }
    }
  } catch { /* the job list stands without it */ }

  // Tips go straight to the Easer's account (api/booking/tip.js); this is their view of them.
  try {
    const { data, error } = await sb.from('booking_tips')
      .select('booking_id, amount_cents, stripe_fee_cents, easer_net_cents, refunded_cents, status, created_at')
      .eq('easer_id', easerId)
      .in('booking_id', ids);
    if (!error) {
      const byBooking = new Map();
      (data || []).forEach(t => {
        if (!byBooking.has(t.booking_id)) byBooking.set(t.booking_id, []);
        byBooking.get(t.booking_id).push(t);
      });
      for (const [bookingId, rows] of byBooking) {
        const summary = summarizeTips(rows);
        if (summary.count) get(bookingId).tips = summary;
      }
    }
  } catch { /* tips not available */ }

  // The latest time this Easer proposed (migration 110).
  try {
    const { data, error } = await sb.from('easer_time_proposals')
      .select('booking_id, proposed_date, proposed_time, note, status, created_at, responded_at')
      .eq('easer_id', easerId)
      .in('booking_id', ids)
      .order('created_at', { ascending: false });
    if (!error) {
      (data || []).forEach(p => {
        const entry = get(p.booking_id);
        if (!entry.timeProposal) {
          entry.timeProposal = { date: p.proposed_date, time: p.proposed_time, note: p.note || null, status: p.status, createdAt: p.created_at, respondedAt: p.responded_at || null };
        }
      });
    }
  } catch { /* proposals not available */ }

  // Extra work on the job. Description and status only: the customer's price is
  // not the Easer's pay (Rule 3); their share arrives with their earnings.
  try {
    const changeOrders = await loadChangeOrders(ids, { sb });
    for (const [bookingId, rows] of changeOrders) {
      const visible = (rows || []).filter(r => r.status !== CHANGE_ORDER_STATUS.VOIDED);
      if (visible.length) {
        get(bookingId).extraWork = visible.map(r => ({
          id: r.id,
          description: r.description,
          status: r.status,
          requestedBy: r.created_by || 'owner',
          createdAt: r.created_at,
        }));
      }
    }
  } catch { /* change orders not available */ }

  // Whether this Easer has rated the customer (migration 110).
  try {
    const { data, error } = await sb.from('customer_feedback')
      .select('booking_id, rating, flagged, created_at')
      .eq('easer_id', easerId)
      .in('booking_id', ids);
    if (!error) {
      (data || []).forEach(f => {
        get(f.booking_id).customerFeedback = { rating: f.rating ?? null, flagged: f.flagged === true, createdAt: f.created_at };
      });
    }
  } catch { /* feedback not available */ }

  return extras;
}

/** Field names on each job in /api/booking/my-assignments. */
export function applyEaserJobExtras(booking, extra = {}) {
  booking._customer_unavailable = extra.customerUnavailable || null;
  booking._previous_slot = extra.previousSlot || null;
  booking._tips = extra.tips || null;
  booking._time_proposal = extra.timeProposal || null;
  booking._extra_work = extra.extraWork || [];
  booking._customer_feedback = extra.customerFeedback || null;
}
