// Who receives a message the customer sends about a booking.
//
// Once an Easer has ACCEPTED the job, the customer and the Easer talk to each
// other on the platform (owner gets a copy, never has to relay). Before that,
// there is no pro yet, so the message goes to the AssembleAtEase team.
// message.js routes with this and track.js labels the message box with it, so
// the page never tells the customer one recipient while the server delivers
// to another.
export function customerMessageRecipient(booking) {
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
