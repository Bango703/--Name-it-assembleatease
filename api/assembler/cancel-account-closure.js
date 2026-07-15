import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { esc, ownerEmail, sendEmail } from '../_email.js';
import { normalizeEaserClosureStatus } from '../_easer-closure.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const authorization = String(req.headers?.authorization || '');
  if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await authClient.auth.getUser(authorization.slice(7));
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id, full_name, email, account_closure_status')
    .eq('id', user.id)
    .eq('role', 'assembler')
    .maybeSingle();
  if (profileError) {
    console.error('Cancel closure profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({ error: 'Account closure status could not be verified. Please try again.' });
  }
  if (!profile) return res.status(403).json({ error: 'Easer access required' });

  const closureStatus = normalizeEaserClosureStatus(profile);
  if (closureStatus === 'completed') {
    return res.status(409).json({
      error: 'This Easer account is already closed and cannot be reopened from self-service.',
      code: 'ACCOUNT_ALREADY_CLOSED',
    });
  }
  if (!['requested', 'reviewing'].includes(closureStatus)) {
    return res.status(200).json({
      ok: true,
      alreadyCancelled: true,
      closureStatus: closureStatus || null,
    });
  }

  const { data: cancelledProfile, error: cancelError } = await sb.from('profiles')
    .update({
      account_closure_status: 'cancelled',
      is_available: false,
    })
    .eq('id', user.id)
    .eq('role', 'assembler')
    .eq('account_closure_status', closureStatus)
    .select('id, full_name, email, account_closure_status')
    .maybeSingle();

  if (cancelError) {
    const message = String(cancelError.message || cancelError);
    console.error('Cancel closure transaction failed:', message);
    return res.status(503).json({
      error: 'Account closure cancellation could not be saved safely. Please try again.',
      code: 'ACCOUNT_CLOSURE_CANCEL_FAILED',
    });
  }

  if (!cancelledProfile) {
    const { data: latestProfile } = await sb.from('profiles')
      .select('account_closure_status')
      .eq('id', user.id)
      .eq('role', 'assembler')
      .maybeSingle();
    const latestStatus = normalizeEaserClosureStatus(latestProfile);
    if (latestStatus === 'cancelled' || !latestStatus) {
      return res.status(200).json({ ok: true, closureStatus: latestStatus || 'cancelled', alreadyCancelled: true });
    }
    if (latestStatus === 'completed') {
      return res.status(409).json({
        error: 'This Easer account is already closed and cannot be reopened from self-service.',
        code: 'ACCOUNT_ALREADY_CLOSED',
      });
    }
    return res.status(409).json({
      error: 'Closure status changed while cancellation was being processed. Refresh and try again.',
      code: 'ACCOUNT_CLOSURE_STATUS_CHANGED',
      closureStatus: latestStatus || null,
    });
  }

  const notice = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Easer closure request cancelled - ${cancelledProfile.full_name || cancelledProfile.email}`,
    html: `<p><strong>${esc(cancelledProfile.full_name || 'Easer')}</strong> (${esc(cancelledProfile.email)}) cancelled their account closure request.</p><p>Their availability remains Offline until they toggle Online again.</p>`,
    meta: { notificationType: 'easer_account_closure_cancelled', recipientType: 'owner', recipientUserId: user.id, disableDedupe: true },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  return res.status(200).json({
    ok: true,
    closureStatus: 'cancelled',
    ownerNotified: notice?.ok === true && !notice?.suppressed,
    warning: notice?.ok === true && !notice?.suppressed ? null : 'owner_notification_failed',
  });
}
