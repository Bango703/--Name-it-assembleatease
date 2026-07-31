import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { id, status } = req.query;

  // ── DELETE a job ──────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (process.env.VERCEL_ENV === 'production' || String(process.env.ENABLE_TEST_ENDPOINTS || '').toLowerCase() !== 'true') {
      return res.status(405).json({ error: 'Marketplace jobs must be closed, not permanently deleted.' });
    }
    if (!isUuid(id)) return res.status(400).json({ error: 'Valid job ID required' });
    // Delete bids first (FK constraint)
    await sb.from('bids').delete().eq('job_id', id);
    const { error } = await sb.from('jobs').delete().eq('id', id);
    if (error) {
      console.error('Owner delete job error:', error);
      return res.status(500).json({ error: 'Failed to delete job' });
    }
    return res.status(200).json({ success: true });
  }

  // ── PATCH — close/update job status ───────────────────────
  if (req.method === 'PATCH') {
    if (!isUuid(id)) return res.status(400).json({ error: 'Valid job ID required' });
    const newStatus = req.body?.status;
    if (!['open', 'assigned', 'closed', 'cancelled'].includes(newStatus)) {
      return res.status(400).json({ error: 'Status must be open, assigned, closed, or cancelled' });
    }
    const { error, data } = await sb.from('jobs').update({ status: newStatus }).eq('id', id).select('id');
    if (error) {
      console.error('Owner patch job error:', error);
      return res.status(500).json({ error: 'Failed to update job' });
    }
    if (!data?.length) return res.status(404).json({ error: 'Job not found' });
    return res.status(200).json({ success: true });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── Single job detail with all bids ──────────────────────
  if (id) {
    const { data, error } = await sb
      .from('jobs')
      .select(`
        *,
        customer:profiles!jobs_customer_id_fkey(id, full_name, email, city, state),
        bids(
          id, amount, bid_type, note, status, created_at,
          assembler:profiles!bids_assembler_id_fkey(id, full_name, city, rating, completed_jobs)
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      console.error('Owner job detail error:', error);
      return res.status(500).json({ error: 'Failed to fetch job' });
    }

    return res.status(200).json({ job: data });
  }

  // ── List all marketplace jobs ─────────────────────────────
  let query = sb
    .from('jobs')
    .select(`
      id, title, description, category, city, state, status,
      budget_type, budget_min, budget_max, fixed_price,
      created_at, assigned_at, completed_at,
      customer:profiles!jobs_customer_id_fkey(id, full_name, city),
      bids(count)
    `, { count: 'exact' })
    .order('created_at', { ascending: false });

  if (status && status !== 'all') query = query.eq('status', status);

  const { data, error, count } = await query;

  if (error) {
    console.error('Owner jobs list error:', error);
    return res.status(500).json({ error: 'Failed to fetch marketplace jobs' });
  }

  return res.status(200).json({ jobs: data || [], count: count || 0 });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
