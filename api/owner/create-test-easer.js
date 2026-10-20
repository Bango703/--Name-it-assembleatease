import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV === 'production' && process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const testEmail    = 'testeaser@assembleatease.com';
  const testPassword = 'TestEaser2024!';

  let userId;

  // Find existing auth user by listing (admin API has no getUserByEmail)
  try {
    const { data: list } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const found = (list?.users || []).find(u => u.email === testEmail);
    if (found) {
      // Reset password on existing account — no delete/recreate needed
      await sb.auth.admin.updateUserById(found.id, {
        password: testPassword,
        email_confirm: true,
        user_metadata: { role: 'assembler', full_name: 'Test Easer' },
      });
      userId = found.id;
    }
  } catch(e) {
    console.warn('Auth user lookup failed:', e.message);
  }

  // Not found — create fresh
  if (!userId) {
    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { role: 'assembler', full_name: 'Test Easer' },
    });
    if (authErr) {
      console.error('Test easer create error:', authErr);
      return res.status(500).json({ error: authErr.message });
    }
    userId = authData.user.id;
  }

  // Upsert core profile
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
    return res.status(500).json({ error: 'Profile upsert failed: ' + profileErr.message });
  }

  // Extended fields — non-fatal if columns missing
  await sb.from('profiles').update({
    services_offered: ['Furniture Assembly', 'TV & Display Mounting'],
    has_tools: true, has_transport: true,
    years_experience: 3,
    bio: 'Test account for platform testing.',
    rating: 4.8,
    completed_jobs: 5,
    is_available: true,
  }).eq('id', userId).then(({ error: e }) => {
    if (e) console.warn('Extended fields skipped:', e.message);
  });

  return res.status(200).json({
    ok: true,
    email: testEmail,
    password: testPassword,
    loginUrl: 'https://www.assembleatease.com/auth/login',
    dashboard: 'https://www.assembleatease.com/assembler/',
  });
}
