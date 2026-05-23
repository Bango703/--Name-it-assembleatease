import { getSupabase } from '../_supabase.js';

/**
 * GET /api/admin/seed-test-booking?pw=OWNER_PASSWORD
 *
 * Inserts one realistic confirmed booking for pipeline testing.
 * No Stripe charge — payment_status is set to 'test' so capture is skipped.
 * Safe to run multiple times — creates a new booking each time with a unique ref.
 * Delete this file when testing is complete.
 */
export default async function handler(req, res) {
  const pw = req.query.pw || req.headers['x-owner-password'];
  if (!process.env.OWNER_PASSWORD || pw !== process.env.OWNER_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();

  const suffix = Date.now().toString(36).toUpperCase().slice(-5);
  const ref    = `AE-TEST-${suffix}`;

  const today  = new Date();
  const jobDay = new Date(today.getTime() + 3 * 86400000);
  const dateStr = jobDay.toISOString().slice(0, 10);

  const { data, error } = await sb.from('bookings').insert({
    ref,
    service:          'IKEA KALLAX 4×4 Shelf Assembly',
    customer_name:    'Alex Rivera',
    customer_email:   process.env.NOTIFY_EMAIL || 'service@assembleatease.com',
    customer_phone:   '(512) 555-0142',
    date:             dateStr,
    time:             '10:00 AM',
    address:          '1812 W 35th St, Austin, TX 78703',
    details:          'Unit is still in the box. Access via front door. Dog-friendly home.',
    status:           'confirmed',
    payment_status:   'test',
    total_price:      16500,
    amount_charged:   16500,
    platform_fee_pct: 20,
    platform_fee:     3300,
    dispatch_attempt: 0,
    needs_manual_dispatch: false,
    dispatch_paused:  false,
  }).select('id, ref').single();

  if (error) {
    console.error('seed-test-booking error:', error);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    ok: true,
    ref:  data.ref,
    id:   data.id,
    note: 'payment_status=test — Stripe capture is skipped on complete. All other pipeline steps are real.',
    dashboard: `https://www.assembleatease.com/owner/?booking=${data.id}`,
  });
}
