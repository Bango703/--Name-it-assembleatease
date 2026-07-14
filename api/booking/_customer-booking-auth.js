export function normalizeCustomerEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function customerOwnsBooking(booking, user) {
  if (!booking || !user) return false;
  if (booking.customer_id) return booking.customer_id === user.id;

  const userEmail = normalizeCustomerEmail(user.email);
  const bookingEmail = normalizeCustomerEmail(booking.customer_email);
  return !!userEmail && !!bookingEmail && userEmail === bookingEmail;
}
