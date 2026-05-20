import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * POST /api/owner/create-test-easer
 * Creates a fully approved test Easer account for internal testing.
 * Bypasses fee, verification, and sets a known password immediately.
 * Owner-auth required.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();

  const testEmail    = 'testeaser@assembleatease.com';
  const testPassword = 'TestEaser2024!';

  // Delete existing test account if any
  try {
    const { data: existing } = await sb.from('profiles').select('id').eq('email', testEmail).maybeSingle();
    if (existing) {
      await sb.from('profiles').delete().eq('id', existing.id);
      await sb.auth.admin.deleteUser(existing.id).catch(() => {});
    }
  } catch(e) { /* non-fatal */ }

  // Create auth user with known password
  const { data: authData, error: authErr } = await sb.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
    user_metadata: { role: 'assembler', full_name: 'Test Easer' },
  });

  if (authErr) {
    console.error('Test easer auth error:', authErr);
    return res.status(500).json({ error: authErr.message });
  }

  const userId = authData.user.id;

  // Step 1 — core profile (columns guaranteed to exist)
  const { error: profileErr } = await sb.from('profiles').upsert({
    id: userId,
    full_name: 'Test Easer',
    email: testEmail,
    phone: '737-000-0001',
    role: 'assembler',
    city: 'Austin',
    zip: '78701',
    tier: 'starter',
    identity_verified: true,
    identity_verified_at: new Date().toISOString(),
    application_status: 'approved',
    payment_confirmed: true,
    application_fee_paid: true,
  }, { onConflict: 'id' });

  if (profileErr) {
    console.error('Test easer profile error:', profileErr);
    return res.status(500).json({ error: 'Profile create failed: ' + profileErr.message });
  }

  // Step 2 — extended fields (non-fatal if columns don't exist yet)
  await sb.from('profiles').update({
    services_offered: ['Furniture Assembly', 'TV & Display Mounting', 'Home Repairs'],
    has_tools: true,
    has_transport: true,
    years_experience: 3,
    bio: 'Test account for platform testing.',
    hourly_rate: 25,
    rating: 4.8,
    completed_jobs: 5,
    is_available: true,
  }).eq('id', userId).then(({ error: e }) => {
    if (e) console.warn('Extended profile fields skipped:', e.message);
  });

  return res.status(200).json({
    ok: true,
    email: testEmail,
    password: testPassword,
    loginUrl: 'https://www.assembleatease.com/auth/login',
    dashboard: 'https://www.assembleatease.com/assembler/',
  });
}
