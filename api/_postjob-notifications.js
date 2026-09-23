import { normalizeEmail } from './_broadcast.js';

// Reuse the existing customer marketing preference source. A missing/unreadable
// preference list is not permission to send another non-essential message.
export async function loadPostjobSuppressions(sb) {
  const { data, error } = await sb.from('email_suppressions').select('email');
  if (error) throw error;
  return new Set((data || []).map(row => normalizeEmail(row.email)));
}

export function canSendPostjobMessage(booking, { openCases, suppressed }) {
  return booking.status === 'completed'
    && booking.is_test_booking !== true
    && booking.return_visit_required !== true
    && Boolean(normalizeEmail(booking.customer_email))
    && !openCases.has(booking.id)
    && !suppressed.has(normalizeEmail(booking.customer_email));
}
