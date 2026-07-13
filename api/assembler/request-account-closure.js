import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { esc, ownerEmail, sendEmail } from '../_email.js';

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
  const { data: profile } = await sb.from('profiles')
    .select('id, full_name, email, account_closure_status')
    .eq('id', user.id)
    .eq('role', 'assembler')
    .maybeSingle();
  if (!profile) return res.status(403).json({ error: 'Easer access required' });
  if (['requested', 'reviewing'].includes(profile.account_closure_status)) {
    return res.status(200).json({ ok: true, alreadyRequested: true });
  }

  const { data: activeJobs, error: jobsError } = await sb.from('bookings')
    .select('ref')
    .eq('assembler_id', user.id)
    .in('status', ['confirmed', 'en_route', 'arrived', 'in_progress'])
    .limit(5);
  if (jobsError) return res.status(500).json({ error: 'Could not verify active assignments' });
  if (activeJobs?.length) {
    return res.status(409).json({
      error: 'Account closure cannot start while you have active assignments. Contact support to reassign them safely.',
      activeBookingRefs: activeJobs.map(job => job.ref),
    });
  }

  const requestedAt = new Date().toISOString();
  const { error: updateError } = await sb.from('profiles').update({
    account_closure_requested_at: requestedAt,
    account_closure_status: 'requested',
    account_closure_reason: reason || null,
    is_available: false,
  }).eq('id', user.id);
  if (updateError) return res.status(500).json({ error: 'Could not request account closure' });

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
    ownerNotified: notice?.ok === true && !notice?.suppressed,
    warning: notice?.ok === true && !notice?.suppressed ? null : 'owner_notification_failed',
  });
}
