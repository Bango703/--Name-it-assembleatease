import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

const CONFIRM_TOKEN = 'DELETE_ZERO_VALUE_SIMULATIONS';
const MAX_DELETE_COUNT = 25;
const TEST_NAME_PREFIX = 'SIM-';
const BLOCKING_RELATED_TABLES = [
  ['reviews', 'booking_id'],
  ['booking_items', 'booking_id'],
  ['booking_evidence', 'booking_id'],
  ['booking_notes', 'booking_id'],
  ['dispatch_offers', 'booking_id'],
  ['activity_logs', 'booking_id'],
  ['notification_log', 'booking_id'],
  ['financial_event_audit', 'booking_id'],
  ['payout_ledger', 'booking_id'],
  ['assemblecash_ledger', 'booking_id'],
];

/**
 * POST /api/owner/bulk-delete
 *
 * Test-data utility only. This endpoint cannot delete production bookings or
 * any booking that has money, Stripe, dispatch, evidence, notification, review,
 * payout, or audit history. Real business records must be retained and changed
 * through their explicit operational workflows.
 *
 * Body: { ids: string[], confirm: 'DELETE_ZERO_VALUE_SIMULATIONS' }
 */
export default async function handler(req, res) {
  if (process.env.VERCEL_ENV === 'production' || process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const ids = Array.from(new Set(Array.isArray(body.ids) ? body.ids.map(String) : []));
  if (!ids.length || ids.length > MAX_DELETE_COUNT || ids.some(id => !isUuid(id))) {
    return res.status(400).json({ error: `Provide 1-${MAX_DELETE_COUNT} valid booking ids.` });
  }
  if (body.confirm !== CONFIRM_TOKEN) {
    return res.status(400).json({
      error: 'Explicit test-data confirmation is required.',
      confirmToken: CONFIRM_TOKEN,
    });
  }

  const sb = getSupabase();
  const { data: bookings, error: loadError } = await sb
    .from('bookings')
    .select('*')
    .in('id', ids);

  if (loadError) {
    console.error('Bulk delete booking load error:', loadError);
    return res.status(500).json({ error: 'Failed to verify test bookings.' });
  }
  if ((bookings || []).length !== ids.length) {
    return res.status(404).json({ error: 'One or more bookings were not found. Nothing was deleted.' });
  }

  const unsafeBookings = (bookings || [])
    .map(getBookingBlockers)
    .filter(result => result.reasons.length);
  if (unsafeBookings.length) {
    return res.status(409).json({
      error: 'Only explicit zero-value simulation bookings with no business history can be deleted.',
      blocked: unsafeBookings,
    });
  }

  const relatedBlockers = [];
  for (const [table, column] of BLOCKING_RELATED_TABLES) {
    const { data, error } = await sb.from(table).select(column).in(column, ids).limit(1);
    if (error) {
      console.error('Bulk delete safety check failed:', table, error.message);
      return res.status(503).json({
        error: `Could not verify ${table}. Nothing was deleted.`,
      });
    }
    if (data?.length) relatedBlockers.push(table);
  }
  if (relatedBlockers.length) {
    return res.status(409).json({
      error: 'Bookings with operational, customer, or financial history cannot be deleted.',
      blockedTables: relatedBlockers,
    });
  }

  const { error: deleteError, count } = await sb
    .from('bookings')
    .delete({ count: 'exact' })
    .in('id', ids);
  if (deleteError || count !== ids.length) {
    console.error('Bulk delete booking error:', deleteError || `expected ${ids.length}, deleted ${count}`);
    return res.status(500).json({ error: 'Failed to delete all verified test bookings.' });
  }

  console.log(JSON.stringify({
    audit: true,
    action: 'delete_zero_value_simulations',
    actor: 'owner',
    ids,
    count,
    timestamp: new Date().toISOString(),
  }));
  return res.status(200).json({ ok: true, deleted: count });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getBookingBlockers(booking) {
  const reasons = [];
  if (!String(booking.customer_name || '').startsWith(TEST_NAME_PREFIX)) reasons.push('missing SIM- customer-name marker');
  if (!['pending', 'cancelled'].includes(String(booking.status || '').toLowerCase())) reasons.push('active or completed status');
  if (String(booking.payment_status || '').toLowerCase() !== 'not_required') reasons.push('payment state exists');
  if (booking.assembler_id || booking.assembler_name || booking.assigned_at) reasons.push('Easer assignment exists');

  const moneyFields = [
    'total_price', 'tax_amount', 'service_call_fee', 'cancellation_fee',
    'deposit_amount', 'amount_charged',
    'assembler_due', 'platform_fee', 'platform_revenue', 'payout_amount',
    'refund_amount', 'promo_discount_cents', 'assemblecash_redeemed_cents',
  ];
  if (moneyFields.some(field => Number(booking[field] || 0) !== 0)) reasons.push('non-zero money state');

  const stripeState = Object.entries(booking).some(([key, value]) =>
    (key.startsWith('stripe_') || key.includes('payment_intent'))
    && value !== null && value !== '' && value !== false
  );
  if (stripeState) reasons.push('Stripe state exists');
  if (booking.payout_status && !['unpaid', 'not_required'].includes(String(booking.payout_status).toLowerCase())) {
    reasons.push('payout state exists');
  }

  return { id: booking.id, ref: booking.ref, reasons };
}
