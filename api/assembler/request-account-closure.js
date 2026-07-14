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

  const reason = String(req.body?.reason || '').trim();
  if (reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or fewer' });

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id, full_name, email, account_closure_status')
    .eq('id', user.id)
    .eq('role', 'assembler')
    .maybeSingle();
  if (profileError) {
    console.error('Account closure profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({ error: 'Account closure eligibility could not be verified. Please try again.' });
  }
  if (!profile) return res.status(403).json({ error: 'Easer access required' });

  const existingClosureStatus = normalizeEaserClosureStatus(profile);
  if (existingClosureStatus === 'completed') {
    return res.status(409).json({
      error: 'This Easer account is already closed. Contact support if you need a reviewed re-onboarding.',
      code: 'ACCOUNT_ALREADY_CLOSED',
    });
  }
  if (['requested', 'reviewing'].includes(existingClosureStatus)) {
    return res.status(200).json({
      ok: true,
      alreadyRequested: true,
      closureStatus: existingClosureStatus,
    });
  }

  const { data: closureRows, error: closureError } = await sb.rpc(
    'request_easer_account_closure',
    { p_assembler_id: user.id, p_reason: reason || null },
  );
  if (closureError) {
    const message = String(closureError.message || closureError);
    if (/active (assignment|job)|assigned (booking|job)/i.test(message)) {
      return res.status(409).json({
        error: 'Account closure cannot start while you have active assignments. Contact support to reassign them safely.',
        code: 'ACCOUNT_CLOSURE_ACTIVE_ASSIGNMENTS',
      });
    }
    if (/already closed|closure.*completed|completed.*closure/i.test(message)) {
      return res.status(409).json({
        error: 'This Easer account is already closed. Contact support if you need a reviewed re-onboarding.',
        code: 'ACCOUNT_ALREADY_CLOSED',
      });
    }
    console.error('Account closure transaction failed:', message);
    return res.status(503).json({
      error: 'Account closure could not be saved safely. Please try again.',
      code: 'ACCOUNT_CLOSURE_TRANSACTION_FAILED',
    });
  }

  const closure = Array.isArray(closureRows) ? closureRows[0] : closureRows;
  if (!closure?.closure_status) {
    console.error('Account closure transaction returned no authoritative state');
    return res.status(503).json({
      error: 'Account closure could not be confirmed. Please try again.',
      code: 'ACCOUNT_CLOSURE_STATE_MISSING',
    });
  }
  if (closure.closure_status === 'completed') {
    return res.status(409).json({
      error: 'This Easer account is already closed. Contact support if you need a reviewed re-onboarding.',
      code: 'ACCOUNT_ALREADY_CLOSED',
    });
  }
  if (closure.already_requested === true) {
    return res.status(200).json({
      ok: true,
      alreadyRequested: true,
      closureStatus: closure.closure_status,
      requestedAt: closure.requested_at || null,
    });
  }

  const requestedAt = closure.requested_at || new Date().toISOString();

  const notice = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Easer account closure request - ${profile.full_name || profile.email}`,
    html: `<p><strong>${esc(profile.full_name || 'Easer')}</strong> (${esc(profile.email)}) requested account closure.</p><p>They were switched offline. Review retention, payouts, tax records, and access before completing the request.</p>${reason ? `<p><strong>Reason:</strong> ${esc(reason)}</p>` : ''}`,
    meta: { notificationType: 'easer_account_closure', recipientType: 'owner', recipientUserId: user.id, disableDedupe: true },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  return res.status(200).json({
    ok: true,
    requestedAt,
    closureStatus: closure.closure_status,
    ownerNotified: notice?.ok === true && !notice?.suppressed,
    warning: notice?.ok === true && !notice?.suppressed ? null : 'owner_notification_failed',
  });
}
