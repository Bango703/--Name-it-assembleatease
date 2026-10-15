/**
 * _reviews-truth.js: the ONE answer to "which reviews count".
 *
 * A review left on a test booking (bookings.is_test_booking) is a rehearsal, not
 * a customer's opinion. 2026-10-15: the App Review test job's 5-star rating was
 * the only review in the system, so the owner dashboard showed "1 review, 5.0"
 * while the owner's real account correctly showed none.
 *
 * Every reader that counts or averages reviews uses summarizeReviews over rows
 * from loadReviews, so the dashboard, the monitor and the finance goals agree.
 */

/** Reviews (newest first) with is_test set from their booking. */
export async function loadReviews(sb, { approvedOnly = false } = {}) {
  let query = sb.from('reviews').select('*').order('created_at', { ascending: false });
  if (approvedOnly) query = query.eq('approved', true);
  const { data, error } = await query;
  if (error) throw new Error(`reviews lookup failed: ${error.message || error}`);
  const reviews = data || [];

  const bookingIds = [...new Set(reviews.map(r => r.booking_id).filter(Boolean))];
  const testIds = new Set();
  if (bookingIds.length) {
    const { data: bookings, error: bookingError } = await sb.from('bookings')
      .select('id, is_test_booking')
      .in('id', bookingIds);
    if (bookingError) throw new Error(`review bookings lookup failed: ${bookingError.message || bookingError}`);
    for (const b of bookings || []) if (b.is_test_booking === true) testIds.add(b.id);
  }
  return reviews.map(r => ({ ...r, is_test: testIds.has(r.booking_id) }));
}

/** Counts over real reviews only. Test reviews are counted separately and nowhere else. */
export function summarizeReviews(reviews) {
  const real = (reviews || []).filter(r => r && r.is_test !== true);
  const rated = real.map(r => Number(r.rating || 0)).filter(n => n > 0);
  const total = real.length;
  const average = rated.length ? rated.reduce((s, n) => s + n, 0) / rated.length : null;
  return {
    total,
    average,
    fiveStar: real.filter(r => Number(r.rating) === 5).length,
    hidden: real.filter(r => r.approved !== true).length,
    testExcluded: (reviews || []).length - total,
  };
}
