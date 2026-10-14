// Who receives a message the customer sends about a booking.
//
// Once an Easer has ACCEPTED the job, the customer and the Easer talk to each
// other on the platform (owner gets a copy, never has to relay). Before that,
// there is no pro yet, so the message goes to the AssembleAtEase team.
// message.js routes with this and track.js labels the message box with it, so
// the page never tells the customer one recipient while the server delivers
// to another.
//
// Once the job is finished (completed, cancelled, declined or refunded) the
// direct line closes and the customer writes to AssembleAtEase, as Uber, Lyft
// and DoorDash do after a trip. The Easer side already closes there: message.js
// refuses an Easer-to-customer message once the job is no longer active
// (evaluateCustomerContactRelease). Without this the customer could still write
// to the pro, the pro was notified, and the pro's app had nowhere to read it.
export const FINISHED_BOOKING_STATUSES = Object.freeze(['completed', 'cancelled', 'declined', 'refunded']);

export function customerMessageRecipient(booking) {
  if (FINISHED_BOOKING_STATUSES.includes(String(booking?.status || ''))) return 'owner';
  return booking?.assembler_id && booking?.assembler_accepted_at ? 'assembler' : 'owner';
}

// Which of the Easer's two conversations a message belongs to. An Easer has a
// thread with the customer and a separate thread with AssembleAtEase; a message
// is in the customer thread when the customer wrote it or received it, and in
// the AssembleAtEase thread otherwise. message.js stamps it on every row it
// returns to an Easer, so the app and the web dashboard never sort for themselves.
export function easerMessageThread(message = {}) {
  return message.sender === 'customer' || message.recipient_type === 'customer' ? 'customer' : 'team';
}
