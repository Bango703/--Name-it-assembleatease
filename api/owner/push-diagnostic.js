import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(403).json({ error: 'Unauthorized' });

  const report = {};
  const sb = getSupabase();

  // 1. VAPID keys
  report.vapid_public_key  = process.env.VAPID_PUBLIC_KEY  ? 'SET (' + process.env.VAPID_PUBLIC_KEY.slice(0,12) + '…)' : 'MISSING';
  report.vapid_private_key = process.env.VAPID_PRIVATE_KEY ? 'SET' : 'MISSING';
  report.vapid_email       = process.env.VAPID_EMAIL || 'not set (uses default)';

  // 2. push_subscriptions table
  try {
    const { data, error, count } = await sb
      .from('push_subscriptions')
      .select('user_id, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      report.table_status = 'ERROR: ' + error.message;
      report.subscriptions = [];
    } else {
      report.table_status = 'OK';
      report.total_subscriptions = count;
      report.recent = (data || []).map(r => ({
        user_id: r.user_id,
        saved: r.created_at,
      }));
    }
  } catch(e) {
    report.table_status = 'EXCEPTION: ' + e.message;
  }

  return res.status(200).json(report);
}
