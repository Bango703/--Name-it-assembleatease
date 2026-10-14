import { getSupabase } from '../_supabase.js';
import { customerAccountBookings, customerAccountUser } from '../booking/_customer-access.js';

/**
 * GET /api/customer/inbox — the customer app's Inbox: one conversation per
 * booking that has messages, newest first, with the last message and how many
 * the customer has not opened. The messages are the ones the booking page and
 * the app's booking screen show (api/booking/message.js, as=customer); opening
 * a conversation in the app marks it read.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = getSupabase();
  const user = await customerAccountUser(sb, req);
  if (!user) return res.status(401).json({ error: 'Sign in again to see your messages.' });

  const { bookings, error } = await customerAccountBookings(sb, user, 'id, ref, service, date, time, status, customer_id, customer_email, created_at, assembler_name, assembler_accepted_at');
  if (error) return res.status(500).json({ error: 'Your messages could not be loaded right now.' });
  if (!bookings.length) return res.status(200).json({ conversations: [] });

  const byId = new Map(bookings.map(b => [b.id, b]));
  const { data: messages, error: messageError } = await sb.from('messages')
    .select('booking_id, sender, recipient_type, body, created_at, read_at')
    .in('booking_id', [...byId.keys()])
    .or('sender.eq.customer,recipient_type.eq.customer')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (messageError) return res.status(500).json({ error: 'Your messages could not be loaded right now.' });

  const conversations = new Map();
  for (const message of messages || []) {
    const booking = byId.get(message.booking_id);
    if (!booking) continue;
    let entry = conversations.get(booking.id);
    if (!entry) {
      entry = {
        ref: booking.ref,
        service: booking.service,
        date: booking.date,
        pro_first_name: booking.assembler_accepted_at && booking.assembler_name ? String(booking.assembler_name).split(' ')[0] : null,
        last_body: message.body,
        last_from: message.sender === 'customer' ? 'you' : (message.sender === 'assembler' ? 'pro' : 'team'),
        last_at: message.created_at,
        unread: 0,
      };
      conversations.set(booking.id, entry);
    }
    if (message.recipient_type === 'customer' && !message.read_at) entry.unread += 1;
  }

  return res.status(200).json({ conversations: [...conversations.values()] });
}
