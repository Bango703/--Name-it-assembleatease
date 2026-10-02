/**
 * Owner message inbox: one owner for what a message is and whether the owner
 * has to act on it.
 *
 * Since in-platform conversations (2026-09-29), once an Easer accepts a job the
 * customer and Easer write to each other directly. The owner dashboard only
 * counted messages addressed to the owner and labelled every customer message
 * "Customer to Owner", so direct conversations were invisible from the
 * dashboard and mislabelled inside a booking. Owner, 2026-10-01: "no messages
 * get received on dashboard".
 *
 * Rules:
 *   - every message is shown, with who wrote it to whom
 *   - a conversation needs the owner when its latest message was written TO
 *     the owner by a customer or Easer (a direct customer-Easer exchange is
 *     visible but needs nothing)
 *   - the Messages badge is the length of the needs-reply list
 */
const PARTY = { customer: 'Customer', assembler: 'Easer', owner: 'You' };

/** "Customer to Easer", "Easer to You", "You to Customer". */
export function messageDirectionLabel(message = {}) {
  const from = PARTY[message.sender] || 'Unknown sender';
  // Rows written before recipient_type existed went to the owner unless the owner sent them.
  const recipient = message.recipient_type || (message.sender === 'owner' ? null : 'owner');
  const to = recipient ? (PARTY[recipient] || 'recipient') : 'recipient';
  return `${from} to ${to}`;
}

export function messageNeedsOwner(message = {}) {
  const recipient = message.recipient_type || (message.sender === 'owner' ? null : 'owner');
  return message.sender !== 'owner' && recipient === 'owner';
}

/**
 * Group recent messages into one conversation per booking, newest activity
 * first, needs-reply first.
 */
export function buildConversations(messages = [], bookings = [], easerNames = new Map()) {
  const bookingById = new Map(bookings.map(b => [b.id, b]));
  const byBooking = new Map();
  for (const m of messages) {
    if (!m?.booking_id) continue;
    const list = byBooking.get(m.booking_id) || [];
    list.push(m);
    byBooking.set(m.booking_id, list);
  }
  const conversations = [];
  for (const [bookingId, list] of byBooking) {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const last = list[list.length - 1];
    const booking = bookingById.get(bookingId) || {};
    const unreadForOwner = list.filter(m => messageNeedsOwner(m) && !m.read_at).length;
    const parties = new Set();
    for (const m of list) { parties.add(m.sender); if (m.recipient_type) parties.add(m.recipient_type); }
    conversations.push({
      bookingId,
      ref: booking.ref || null,
      customerName: booking.customer_name || null,
      easerName: booking.assembler_id ? (easerNames.get(booking.assembler_id) || null) : null,
      bookingStatus: booking.status || null,
      messageCount: list.length,
      unreadForOwner,
      needsReply: messageNeedsOwner(last),
      // Latest message passed between the customer and Easer without the owner.
      direct: ['customer', 'assembler'].includes(last.sender) && ['customer', 'assembler'].includes(last.recipient_type),
      includesEaser: parties.has('assembler'),
      lastMessage: {
        sender: last.sender,
        recipientType: last.recipient_type || null,
        direction: messageDirectionLabel(last),
        body: String(last.body || '').slice(0, 280),
        at: last.created_at,
      },
      // Where the dashboard should open: the Easer thread when the latest message involves the Easer.
      openThread: last.sender === 'assembler' || last.recipient_type === 'assembler' ? 'assembler' : 'customer',
    });
  }
  conversations.sort((a, b) => (a.needsReply === b.needsReply ? 0 : a.needsReply ? -1 : 1)
    || new Date(b.lastMessage.at) - new Date(a.lastMessage.at));
  return {
    conversations,
    needsReply: conversations.filter(c => c.needsReply).map(c => c.bookingId),
  };
}
