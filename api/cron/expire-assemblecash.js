import { getSupabase } from '../_supabase.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/expire-assemblecash
 * Daily. Flips 'available' earned credit past its expiry to 'expired' so it
 * stops counting toward the customer's balance. Idempotent and bounded to
 * earn rows. Requires Authorization: Bearer {CRON_SECRET}.
 */
export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
  const sb = getSupabase();
  const now = new Date().toISOString();

  try {
    const { data, error } = await sb.from('assemblecash_ledger')
      .update({ status: 'expired', updated_at: now })
      .eq('status', 'available')
      .gt('amount_earned_cents', 0)
      .not('expires_at', 'is', null)
      .lt('expires_at', now)
      .select('id');
    if (error) throw error;

    const records = (data || []).length;
    await logCron('expire-assemblecash', { status: 'ok', records, duration: Date.now() - t });
    return res.status(200).json({ ok: true, expired: records });
  } catch (e) {
    await logCron('expire-assemblecash', { status: 'error', error: e && (e.message || String(e)), duration: Date.now() - t });
    console.error('expire-assemblecash error:', e && (e.message || e));
    return res.status(500).json({ error: 'Expiry run failed' });
  }
}
