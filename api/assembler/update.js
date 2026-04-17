import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * POST /api/assembler/update
 * Owner-only: update assembler tier or suspend/reactivate.
 * Body: { assemblerId, tier?, suspended? }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { assemblerId, tier, suspended } = req.body;
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const validTiers = ['pending', 'starter', 'verified', 'elite'];
  if (tier && !validTiers.includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  const sb = getSupabase();

  // Verify assembler exists
  const { data: profile, error: lookupErr } = await sb
    .from('profiles')
    .select('id, full_name, tier')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();

  if (lookupErr || !profile) {
    return res.status(404).json({ error: 'Assembler not found' });
  }

  const updates = {};
  if (tier) updates.tier = tier;
  if (typeof suspended === 'boolean') updates.suspended = suspended;

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  const { error: updateErr } = await sb
    .from('profiles')
    .update(updates)
    .eq('id', assemblerId);

  if (updateErr) {
    console.error('Assembler update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update assembler' });
  }

  return res.status(200).json({ success: true, assemblerId, updates });
}
