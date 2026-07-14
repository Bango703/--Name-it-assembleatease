export function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function bookingEmailMatches(booking, suppliedEmail) {
  const stored = normalizedEmail(booking?.customer_email);
  const supplied = normalizedEmail(suppliedEmail);
  return !!stored && !!supplied && stored === supplied;
}
