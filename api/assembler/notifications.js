import { getSupabase } from '../_supabase.js';
import {
  authenticateBearerUser,
  respondWithEaserAccessError,
} from '../_easer-access.js';

const NOTIFICATION_COPY = {
  approval: ['Account approved', 'Your account is ready for the next required setup step.'],
  assignment_confirmation: ['Job scheduled', 'A job has been added to your schedule.'],
  dispatch_offer: ['New job offer', 'A new job offer is ready for you to review.'],
  easer_work_available: ['Work available', 'New work may be available in your service area.'],
  easer_job_cancelled: ['Job cancelled', 'This job is no longer on your schedule.'],
  owner_message: ['New message', 'You have a new message about this job.'],
  evidence_request: ['Photos requested', 'Open the job to review the requested photos.'],
  reschedule_easer_reconfirmation: ['Schedule changed', 'Review the updated appointment and confirm availability.'],
  owner_edit_easer_reconfirmation: ['Job details changed', 'Review the updated job details and confirm availability.'],
  easer_payout_recorded: ['Payout recorded', 'Your payout status has been updated.'],
  easer_suspended: ['Account status changed', 'Open your profile to review your current account status.'],
  easer_reinstated: ['Account available', 'Your account status has been restored.'],
  easer_tier_changed: ['Professional level updated', 'Your professional level has been updated.'],
  easer_coaching: ['Performance update', 'A new performance update is available.'],
  easer_phone_required: ['Phone number needed', 'Add a phone number to receive job updates.'],
  easer_application_received: ['Application received', 'Your application was received successfully.'],
  easer_application_rejected: ['Application status updated', 'Open your profile to review your application status.'],
  easer_onboarding_link_reissued: ['Setup link ready', 'A new account setup link is available.'],
  identity_resume_link_reissued: ['Verification link ready', 'A new identity verification link is available.'],
  identity_verified_applicant: ['Identity verified', 'Your identity verification is complete.'],
  identity_failed_applicant: ['Verification action needed', 'Open your profile to continue identity verification.'],
  easer_account_closure_requested: ['Closure requested', 'Your account closure request was received.'],
  easer_account_closure_cancelled_confirmation: ['Closure cancelled', 'Your account will remain open.'],
  easer_account_closed: ['Account closed', 'Your account closure is complete.'],
};

function copyFor(type) {
  const exact = NOTIFICATION_COPY[type];
  if (exact) return exact;
  if (String(type || '').startsWith('easer_required_action_')) {
    return ['Action required', 'Open your profile to complete a required account step.'];
  }
  if (String(type || '').startsWith('easer_tier_')) {
    return ['Professional level updated', 'Your professional level has been updated.'];
  }
  return ['Account update', 'A new update is available.'];
}

function hrefFor(row) {
  const type = String(row.notification_type || '');
  if (row.booking_id) return `/assembler/my-assignments?job=${encodeURIComponent(row.booking_id)}`;
  if (/payout/i.test(type)) return '/assembler/payouts';
  return '/assembler/profile';
}

function formatNotification(row) {
  const [title, detail] = copyFor(row.notification_type);
  return {
    id: row.id,
    title,
    detail,
    createdAt: row.sent_at,
    read: Boolean(row.recipient_read_at),
    bookingId: row.booking_id || null,
    href: hrefFor(row),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, role')
    .eq('id', authenticated.user.id)
    .maybeSingle();

  if (profileError) {
    console.error('[easer-notifications] Profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({
      error: 'Notifications could not be loaded right now. Please retry.',
      code: 'NOTIFICATION_PROFILE_LOOKUP_FAILED',
    });
  }
  if (!profile || profile.role !== 'assembler') {
    return res.status(403).json({ error: 'Easer access required' });
  }

  if (req.method === 'POST') {
    const requestedIds = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100)
      : [];

    let update = sb
      .from('notification_log')
      .update({ recipient_read_at: new Date().toISOString() })
      .eq('recipient_user_id', authenticated.user.id)
      .eq('recipient_type', 'easer')
      .is('recipient_read_at', null);
    if (requestedIds.length) update = update.in('id', requestedIds);

    const { error: updateError } = await update;
    if (updateError) {
      console.error('[easer-notifications] Mark-read failed:', updateError.message || updateError);
      return res.status(503).json({
        error: 'Notifications could not be updated right now. Please retry.',
        code: 'NOTIFICATION_MARK_READ_FAILED',
      });
    }
    return res.status(200).json({ ok: true });
  }

  const { data: rows, error: notificationError } = await sb
    .from('notification_log')
    .select('id, booking_id, notification_type, sent_at, recipient_read_at')
    .eq('recipient_user_id', authenticated.user.id)
    .eq('recipient_type', 'easer')
    .in('status', ['queued', 'provider_accepted', 'sent', 'delivered'])
    .order('sent_at', { ascending: false })
    .limit(100);

  if (notificationError) {
    console.error('[easer-notifications] Inbox lookup failed:', notificationError.message || notificationError);
    return res.status(503).json({
      error: 'Notifications could not be loaded right now. Please retry.',
      code: 'NOTIFICATION_QUERY_FAILED',
    });
  }

  // Email and push may represent the same business event. Show one item, using
  // the newest row, so the Easer sees an inbox rather than delivery plumbing.
  const seen = new Set();
  const notifications = [];
  for (const row of rows || []) {
    const key = `${row.notification_type || 'update'}:${row.booking_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notifications.push(formatNotification(row));
    if (notifications.length >= 30) break;
  }

  return res.status(200).json({
    notifications,
    unreadCount: notifications.filter(item => !item.read).length,
  });
}
