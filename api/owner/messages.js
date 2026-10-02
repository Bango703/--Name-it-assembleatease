import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { buildConversations } from '../_owner-inbox.js';

const WINDOW_DAYS = 45;
const MESSAGE_LIMIT = 1000;

// Owner Messages inbox: every booking conversation, including the ones the
// customer and Easer have directly. Read-only; replying happens in the booking.
export function createOwnerMessagesHandler({ supabase = getSupabase, authorize = verifyOwner, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
    const sb = supabase();
    const since = new Date(now().getTime() - WINDOW_DAYS * 86400000).toISOString();

    const { data: messages, error } = await sb.from('messages')
      .select('id, booking_id, sender, recipient_type, body, created_at, read_at')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(MESSAGE_LIMIT + 1);
    if (error || !Array.isArray(messages)) return res.status(503).json({ error: 'Messages could not be loaded. Refresh to try again.' });
    const truncated = messages.length > MESSAGE_LIMIT;
    const rows = messages.slice(0, MESSAGE_LIMIT);

    const bookingIds = [...new Set(rows.map(m => m.booking_id).filter(Boolean))];
    let bookings = [];
    let easerNames = new Map();
    let bookingDetailsAvailable = true;
    if (bookingIds.length) {
      const { data: bk, error: bkError } = await sb.from('bookings').select('id, ref, customer_name, assembler_id, status').in('id', bookingIds);
      if (bkError) bookingDetailsAvailable = false;
      bookings = bk || [];
      const easerIds = [...new Set(bookings.map(b => b.assembler_id).filter(Boolean))];
      if (easerIds.length) {
        const { data: profiles } = await sb.from('profiles').select('id, full_name').in('id', easerIds);
        easerNames = new Map((profiles || []).map(p => [p.id, p.full_name]));
      }
    }
    const { conversations, needsReply } = buildConversations(rows, bookings, easerNames);
    return res.status(200).json({ conversations, needsReply, windowDays: WINDOW_DAYS, truncated, bookingDetailsAvailable });
  };
}

export default createOwnerMessagesHandler();
