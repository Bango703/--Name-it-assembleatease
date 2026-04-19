import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { id, status } = req.query;

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
