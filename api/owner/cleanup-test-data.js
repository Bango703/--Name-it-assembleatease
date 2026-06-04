import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

const DEFAULT_KEEP_NAMES = ['barry b'];
const CONFIRM_TOKEN = 'DELETE_TEST_DATA_KEEP_BARRY_B';
const TEST_REVIEW_PATTERNS = [
  /phase\s*\d/i,
  /post[-\s]?deploy/i,
  /duplicate gate/i,
  /\btest\b/i,
  /seed/i,
];

const RELATED_TABLES = [
  ['booking_items', 'booking_id'],
  ['booking_evidence', 'booking_id'],
  ['booking_notes', 'booking_id'],
  ['dispatch_offers', 'booking_id'],
  ['activity_logs', 'booking_id'],
  ['notification_log', 'booking_id'],
  ['financial_event_audit', 'booking_id'],
  ['payout_ledger', 'booking_id'],
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const dryRun = body.confirm !== CONFIRM_TOKEN;
  const keepNames = normalizeKeepNames(body.keepNames);
  const sb = getSupabase();

  const { data: bookings, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, customer_name, customer_email, service, status, date, assembler_id, assembler_name, total_price, amount_charged');

  if (bookingErr) {
    console.error('cleanup-test-data bookings error:', bookingErr);
    return res.status(500).json({ error: 'Failed to load bookings' });
  }

  const allBookings = bookings || [];
  const testBookings = allBookings.filter(booking => !isKeepBooking(booking, keepNames));
  const keepBookings = allBookings.filter(booking => isKeepBooking(booking, keepNames));
  const testBookingIds = testBookings.map(booking => booking.id).filter(Boolean);
  const affectedAssemblerIds = Array.from(new Set(allBookings.map(b => b.assembler_id).filter(Boolean)));

  const { data: reviews, error: reviewsErr } = await sb
    .from('reviews')
    .select('id, booking_id, customer_name, service, rating, body, approved, created_at');

  if (reviewsErr) {
    console.error('cleanup-test-data reviews error:', reviewsErr);
    return res.status(500).json({ error: 'Failed to load reviews' });
  }

  const testBookingIdSet = new Set(testBookingIds);
  const testReviews = (reviews || []).filter(review =>
    testBookingIdSet.has(review.booking_id)
    || isLikelyInternalTestReview(review)
    || !matchesKeepName(review.customer_name, keepNames)
  );
  const testReviewIds = Array.from(new Set(testReviews.map(review => review.id).filter(Boolean)));

  const preview = {
    dryRun,
    confirmToken: dryRun ? CONFIRM_TOKEN : undefined,
    keepNames,
    keepBookings: keepBookings.map(summarizeBooking),
    deleteBookings: testBookings.map(summarizeBooking),
    deleteReviews: testReviews.map(summarizeReview),
    affectedAssemblerIds,
    warnings: [],
  };

  if (!keepBookings.length) {
    preview.warnings.push('No Barry B booking was found. Dry run only is recommended until the real booking is visible.');
  }

  if (dryRun) return res.status(200).json(preview);

  const operations = [];

  if (testReviewIds.length) {
    operations.push(await deleteIn(sb, 'reviews', 'id', testReviewIds));
  }

  for (const [table, column] of RELATED_TABLES) {
    if (testBookingIds.length) operations.push(await deleteIn(sb, table, column, testBookingIds, { optional: true }));
  }

  if (testBookingIds.length) {
    operations.push(await deleteIn(sb, 'bookings', 'id', testBookingIds));
  }

  const recalcResults = [];
  for (const assemblerId of affectedAssemblerIds) {
    recalcResults.push(await recalcAssemblerStats(sb, assemblerId));
  }

  const failed = operations.filter(op => op.error);
  if (failed.length) {
    console.error('cleanup-test-data partial failure:', failed);
    return res.status(500).json({
      error: 'Cleanup partially failed',
      operations,
      recalcResults,
      preview,
    });
  }

  console.log(JSON.stringify({
    audit: true,
    action: 'cleanup_test_data_keep_barry_b',
    actor: 'owner',
    deletedBookings: testBookingIds.length,
    deletedReviews: testReviewIds.length,
    affectedAssemblerIds,
    timestamp: new Date().toISOString(),
  }));

  return res.status(200).json({
    ok: true,
    deletedBookings: testBookingIds.length,
    deletedReviews: testReviewIds.length,
    operations,
    recalcResults,
    keptBookings: preview.keepBookings,
  });
}

function normalizeKeepNames(value) {
  const names = Array.isArray(value) && value.length ? value : DEFAULT_KEEP_NAMES;
  return names.map(name => String(name || '').trim().toLowerCase()).filter(Boolean);
}

function isKeepBooking(booking, keepNames) {
  return matchesKeepName(booking.customer_name, keepNames);
}

function matchesKeepName(value, keepNames) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) return false;
  return keepNames.some(keep => name === keep || name.startsWith(keep + ' '));
}

function isLikelyInternalTestReview(review) {
  const text = `${review?.body || ''} ${review?.customer_name || ''} ${review?.service || ''}`;
  return TEST_REVIEW_PATTERNS.some(pattern => pattern.test(text));
}

function summarizeBooking(booking) {
  return {
    id: booking.id,
    ref: booking.ref,
    customerName: booking.customer_name,
    service: booking.service,
    status: booking.status,
    date: booking.date,
    amount: booking.amount_charged || booking.total_price || 0,
    easer: booking.assembler_name || null,
  };
}

function summarizeReview(review) {
  return {
    id: review.id,
    bookingId: review.booking_id,
    customerName: review.customer_name,
    service: review.service,
    rating: review.rating,
    body: review.body,
  };
}

async function deleteIn(sb, table, column, ids, options = {}) {
  if (!ids.length) return { table, deleted: 0 };
  const { error, count } = await sb
    .from(table)
    .delete({ count: 'exact' })
    .in(column, ids);

  if (error) {
    const optionalMissing = options.optional && ['42P01', '42703'].includes(error.code);
    if (optionalMissing) return { table, skipped: true, reason: error.message };
    return { table, error: error.message, code: error.code };
  }

  return { table, deleted: count ?? null };
}

async function recalcAssemblerStats(sb, assemblerId) {
  const { data: completedBookings, error: bookingErr } = await sb
    .from('bookings')
    .select('id')
    .eq('assembler_id', assemblerId)
    .eq('status', 'completed');

  if (bookingErr) return { assemblerId, error: bookingErr.message };

  const bookingIds = (completedBookings || []).map(row => row.id).filter(Boolean);
  let reviewCount = 0;
  let rating = 0;

  if (bookingIds.length) {
    const { data: reviewRows, error: reviewErr } = await sb
      .from('reviews')
      .select('rating')
      .eq('approved', true)
      .in('booking_id', bookingIds);

    if (reviewErr) return { assemblerId, error: reviewErr.message };
    reviewCount = (reviewRows || []).length;
    if (reviewCount) {
      rating = Number(((reviewRows || []).reduce((sum, row) => sum + Number(row.rating || 0), 0) / reviewCount).toFixed(1));
    }
  }

  const { error: updateErr } = await sb
    .from('profiles')
    .update({
      completed_jobs: bookingIds.length,
      review_count: reviewCount,
      rating,
    })
    .eq('id', assemblerId);

  if (updateErr) return { assemblerId, error: updateErr.message };
  return { assemblerId, completedJobs: bookingIds.length, reviewCount, rating };
}
