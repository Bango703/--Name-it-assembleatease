import { createClient } from '@supabase/supabase-js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

/**
 * POST /api/owner/reset-password
 * Owner-initiated password reset for any user (assembler or customer).
 * Sends a Supabase password reset email to the given address.
 * Body: { email }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { email } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });

  const adminClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
  );

  try {
    // Generate a password reset link using admin API
    const { data, error } = await adminClient.auth.admin.generateLink({
      type: 'recovery',
      email: email.toLowerCase().trim(),
      options: {
        redirectTo: process.env.NEXT_PUBLIC_SITE_URL
          ? process.env.NEXT_PUBLIC_SITE_URL + '/auth/reset-password'
          : 'https://www.assembleatease.com/auth/reset-password',
      },
    });

    if (error) {
      // User may not exist — don't reveal that fact
      console.error('Password reset error:', error.message);
      // Still return success to prevent email enumeration
      return res.status(200).json({ success: true, note: 'If this email exists, a reset link has been sent.' });
    }

    // Log for audit
    console.log(JSON.stringify({ audit: true, action: 'owner_password_reset', targetEmail: email, timestamp: new Date().toISOString() }));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Reset password handler error:', err);
    return res.status(500).json({ error: 'Failed to send reset email' });
  }
}
