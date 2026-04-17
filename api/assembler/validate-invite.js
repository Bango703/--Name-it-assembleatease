import { getSupabase } from '../_supabase.js';

/**
 * GET /api/assembler/validate-invite?token=XXX
 * Validates an invite token and returns pre-fill data.
 * No auth required — the token IS the auth.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;
  if (!token || typeof token !== 'string' || token.length < 10) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const sb = getSupabase();

  const { data: entry, error } = await sb
    .from('assembler_waitlist')
    .select('name, email, phone, city, state, status, invite_expires_at')
    .eq('invite_token', token)
    .maybeSingle();

  if (error || !entry) {
    return res.status(404).json({ error: 'Invalid or expired invitation link' });
  }

  // Check if already used
  if (entry.status === 'applied' || entry.status === 'approved') {
    return res.status(410).json({ error: 'This invitation has already been used' });
  }

  // Check expiry
  if (entry.invite_expires_at && new Date(entry.invite_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This invitation has expired. Please contact service@assembleatease.com' });
  }

  return res.status(200).json({
    valid: true,
    name: entry.name,
    email: entry.email,
    phone: entry.phone,
    city: entry.city,
    state: entry.state,
  });
}
