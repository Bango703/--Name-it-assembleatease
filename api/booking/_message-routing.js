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
