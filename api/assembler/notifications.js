import { getSupabase } from '../_supabase.js';
import {
  authenticateBearerUser,
  respondWithEaserAccessError,
} from '../_easer-access.js';

// Every notice an Easer can get, as one inbox item: what happened (title and
// detail), where tapping it goes (action), the button that goes there, and its
// group in the inbox (jobs, money or account). Copy states the fact and the
// next step, never why.
//
// action: job | job_customer_messages | job_team_messages | payouts | account
//         | personal_info | today | none
const JOBS = 'jobs';
const MONEY = 'money';
const ACCOUNT = 'account';

function notice(title, detail, action, actionLabel, category) {
  return { title, detail, action, actionLabel, category };
}

export const NOTIFICATION_COPY = Object.freeze({
  // Jobs
  assignment_confirmation: notice('New job', 'AssembleAtEase sent you a job. Review it and accept it.', 'job', 'Review job', JOBS),
  dispatch_offer: notice('New job offer', 'Review the offer and accept it before it expires.', 'job', 'Review offer', JOBS),
  easer_work_available: notice('Work available', 'New jobs are available in your area. Go online to get offers.', 'today', 'Open Today', JOBS),
  crew_added: notice('Added to a crew', 'AssembleAtEase added you as a helper on this job.', 'job', 'View job', JOBS),
  easer_job_cancelled: notice('Job cancelled', 'The customer cancelled this job. It is off your schedule.', 'job', 'View job', JOBS),
  reschedule_easer_reconfirmation: notice('Schedule changed', 'The customer moved this job. Review the new time and accept the job.', 'job', 'Review new time', JOBS),
  owner_edit_easer_reconfirmation: notice('Job details changed', 'AssembleAtEase updated this job. Review the changes and confirm you can still do it.', 'job', 'Review changes', JOBS),
  easer_time_proposal_accepted: notice('New time accepted', 'The customer accepted the time you proposed. The job is on the new time.', 'job', 'View job', JOBS),
  easer_time_proposal_declined: notice('New time declined', 'The customer kept the original time.', 'job', 'View job', JOBS),
  scheduled_payment_easer_hold: notice('Job on hold', 'Do not travel to this job until it is confirmed.', 'job', 'View job', JOBS),
  scheduled_payment_easer_cleared: notice('Job confirmed', 'The hold on this job is cleared. Plan for it as normal.', 'job', 'View job', JOBS),
  arrival_nudge: notice('Check in on arrival', 'Tap Arrived when you are on site. If you are running late, tell the customer from the job.', 'job', 'Open job', JOBS),
  start_nudge: notice('Start the job', 'Tap Start Job before you begin work.', 'job', 'Open job', JOBS),
  return_visit_easer: notice('Return visit scheduled', 'This job continues on another day. The date and the remaining work are on the job.', 'job', 'Open job', JOBS),
  evidence_request: notice('Photos requested', 'AssembleAtEase asked for photos of this job. Open the job to upload them.', 'job', 'Upload photos', JOBS),
  completion: notice('Job completed', 'This job is marked complete. Your earnings for it are in Payouts.', 'payouts', 'Open Payouts', JOBS),
  easer_no_show_recorded: notice('No-show recorded', 'A no-show was recorded on this job. If you were there, message AssembleAtEase from the job.', 'job_team_messages', 'Message AssembleAtEase', JOBS),

  // Messages
  owner_message: notice('Message from AssembleAtEase', 'AssembleAtEase sent you a message about this job.', 'job_team_messages', 'Open messages', JOBS),
  customer_tip: notice('You got a tip', 'A customer tipped you for a job you finished. It goes straight to your account.', 'payouts', 'Open payouts', JOBS),
  change_order_approved: notice('Extra work approved', 'The customer approved the extra work. Go ahead.', 'job', 'Open job', JOBS),
  change_order_declined: notice('Extra work declined', 'The customer declined the extra work. Finish the original job.', 'job', 'Open job', JOBS),
  customer_review: notice('New review', 'A customer rated a job you finished. It is in your Reviews.', 'job', 'Open job', JOBS),
  customer_message: notice('Message from the customer', 'The customer sent you a message about this job.', 'job_customer_messages', 'Open messages', JOBS),

  // Money
  easer_bonus_added: notice('Bonus added', 'AssembleAtEase added a bonus to this job. It is paid with the job.', 'job', 'View job', MONEY),
  easer_reimbursement_added: notice('Reimbursement approved', 'AssembleAtEase approved a reimbursement for this job. It is paid with the job and is not part of your earnings.', 'job', 'View job', MONEY),
  easer_payout_recorded: notice('Payout recorded', 'A payout was recorded for this job. Payouts shows the amount.', 'payouts', 'Open Payouts', MONEY),
  easer_payout_transferred: notice('Payment sent', 'Your earnings for this job were sent to your Stripe account.', 'payouts', 'Open Payouts', MONEY),
  easer_membership_active: notice('Membership active', 'Your Easer membership is active.', 'account', 'Open Account', MONEY),

  // Account
  approval: notice('Account approved', 'You are approved. Finish the remaining setup steps to get jobs.', 'today', 'See setup steps', ACCOUNT),
  easer_welcome: notice('Welcome to AssembleAtEase', 'Your Easer account is set up. Finish the setup steps on Today to get jobs.', 'today', 'See setup steps', ACCOUNT),
  easer_suspended: notice('Account paused', 'You will not get new jobs while your account is paused. Contact AssembleAtEase.', 'account', 'Open Account', ACCOUNT),
  easer_reinstated: notice('Account active again', 'Your account is active again. Go online to get offers.', 'today', 'Open Today', ACCOUNT),
  easer_deactivated: notice('Account deactivated', 'Your account is deactivated. You will not get new jobs.', 'account', 'Open Account', ACCOUNT),
  easer_reactivated: notice('Account access restored', 'You can sign in and get jobs again.', 'today', 'Open Today', ACCOUNT),
  easer_tier_changed: notice('Professional level updated', 'Your professional level changed. Account shows your current level.', 'account', 'Open Account', ACCOUNT),
  easer_coaching: notice('Performance update', 'Review your ratings and reliability on Account.', 'account', 'Open Account', ACCOUNT),
  easer_phone_required: notice('Phone number needed', 'Add a mobile number to get job texts.', 'personal_info', 'Add phone number', ACCOUNT),
  easer_photo_request: notice('New profile photo needed', 'Upload a new profile photo on Account to get job offers again.', 'account', 'Change photo', ACCOUNT),
  easer_application_received: notice('Application received', 'Your application was received.', 'none', null, ACCOUNT),
  easer_application_rejected: notice('Application not approved', 'Your application was not approved. Check your email for details.', 'none', null, ACCOUNT),
  easer_application_waitlisted: notice('Application waitlisted', 'Your application is on the waitlist.', 'none', null, ACCOUNT),
  easer_application_payment_failed: notice('Application payment failed', 'Your application payment did not go through. Check your email for the next step.', 'none', null, ACCOUNT),
  easer_application_fee_dispute_easer: notice('Application payment needs attention', 'Check your email for the next step.', 'none', null, ACCOUNT),
  easer_application_fee_refund_easer: notice('Application fee updated', 'Your application fee status changed. Check your email for details.', 'none', null, ACCOUNT),
  easer_application_fee_hold_cleared: notice('Application payment hold cleared', 'The hold on your application payment is cleared.', 'none', null, ACCOUNT),
  easer_onboarding_link_reissued: notice('Setup link ready', 'A new account setup link was emailed to you.', 'none', null, ACCOUNT),
  identity_resume_link_reissued: notice('Verification link ready', 'Finish identity verification from Today.', 'today', 'Open Today', ACCOUNT),
  identity_verified_applicant: notice('Identity verified', 'Your identity verification is complete.', 'today', 'Open Today', ACCOUNT),
  identity_failed_applicant: notice('Verification needs another try', 'Identity verification did not finish. Try again from Today.', 'today', 'Open Today', ACCOUNT),
  easer_account_closure_requested: notice('Closure requested', 'Your account closure request was received. You are offline.', 'account', 'Open Account', ACCOUNT),
  easer_account_closure_cancelled_confirmation: notice('Closure cancelled', 'Your account stays open.', 'account', 'Open Account', ACCOUNT),
  easer_account_closed: notice('Account closed', 'Your account is closed.', 'none', null, ACCOUNT),
  push_test: notice('Test notification', 'Notifications work on this phone.', 'none', null, ACCOUNT),
});

// One event sent on two channels under two names (email and push or text) is
// one inbox item.
const SAME_AS = Object.freeze({
  evidence_requested: 'evidence_request',
  customer_message_easer: 'customer_message',
});
export function canonicalNoticeType(type) {
  return SAME_AS[type] || type;
}

// Never inbox items: a sign-in code is used once, in the moment.
const NOT_INBOX = new Set(['easer_phone_verification']);

// A required action is logged as easer_required_action_<key> for its email and
// required_action_<key>_<step> for its push. Both are one thing to the Easer.
export function requiredActionKey(type) {
  const t = String(type || '');
  if (t.startsWith('easer_required_action_')) return t.slice('easer_required_action_'.length);
  if (t.startsWith('required_action_')) return t.slice('required_action_'.length).replace(/_\d+$/, '');
  return null;
}

export function noticeFor(type, announcements = new Map()) {
  const exact = NOTIFICATION_COPY[canonicalNoticeType(type)];
  if (exact) return exact;
  const actionKey = requiredActionKey(type);
  if (actionKey) {
    const a = announcements.get(actionKey);
    return notice(
      a?.title || 'Action needed',
      a?.body ? String(a.body).slice(0, 400) : 'Open Today to take care of it.',
      'today',
      a?.action_label || 'Take care of it',
      ACCOUNT,
    );
  }
  if (String(type || '').startsWith('easer_tier_')) return NOTIFICATION_COPY.easer_tier_changed;
  // A type with no entry here still says something and goes somewhere; the
  // native-app test lists every Easer type so this stays a fallback.
  return notice('Account update', 'Open Account to see your current status.', 'account', 'Open Account', ACCOUNT);
}

// Where the app opens an item. A job item without its job falls back to Today.
export function actionFor(row, announcements) {
  const action = noticeFor(row.notification_type, announcements).action;
  if (action.startsWith('job') && !row.booking_id) return 'today';
  return action;
}

function hrefFor(row, action) {
  if (action.startsWith('job')) return `/assembler/my-assignments?job=${encodeURIComponent(row.booking_id)}`;
  if (action === 'payouts') return '/assembler/payouts';
  if (action === 'account' || action === 'personal_info') return '/assembler/profile';
  return '/assembler/';
}

function formatNotification(row, announcements) {
  const item = noticeFor(row.notification_type, announcements);
  const action = actionFor(row, announcements);
  return {
    id: row.id,
    title: item.title,
    detail: item.detail,
    createdAt: row.sent_at,
    read: Boolean(row.recipient_read_at),
    bookingId: row.booking_id || null,
    href: hrefFor(row, action),
    action,
    actionLabel: action === 'today' && item.action !== 'today' ? 'Open Today' : item.actionLabel,
    category: item.category,
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

  // Older pages: ?before=<createdAt of the last item shown>.
  const beforeParam = String(req.query?.before || '').trim();
  const before = beforeParam && Number.isFinite(Date.parse(beforeParam)) ? new Date(beforeParam).toISOString() : null;
  const SCAN = 100;
  let inboxQuery = sb
    .from('notification_log')
    .select('id, booking_id, notification_type, sent_at, recipient_read_at')
    .eq('recipient_user_id', authenticated.user.id)
    .eq('recipient_type', 'easer')
    .in('status', ['queued', 'provider_accepted', 'sent', 'delivered']);
  if (before) inboxQuery = inboxQuery.lt('sent_at', before);
  const { data: rows, error: notificationError } = await inboxQuery
    .order('sent_at', { ascending: false })
    .limit(SCAN);

  if (notificationError) {
    console.error('[easer-notifications] Inbox lookup failed:', notificationError.message || notificationError);
    return res.status(503).json({
      error: 'Notifications could not be loaded right now. Please retry.',
      code: 'NOTIFICATION_QUERY_FAILED',
    });
  }

  // Required actions are named and described by their announcement. A lookup
  // failure only means the generic wording is used; the inbox still loads.
  const announcements = new Map();
  if ((rows || []).some(row => requiredActionKey(row.notification_type))) {
    const { data: found } = await sb.from('easer_announcements').select('key, title, body, action_label');
    for (const a of found || []) if (a?.key && a?.title) announcements.set(a.key, a);
  }

  // Email and push may represent the same business event. Show one item, using
  // the newest row, so the Easer sees an inbox rather than delivery plumbing.
  const PAGE = 30;
  const seen = new Set();
  const notifications = [];
  let scanned = 0;
  for (const row of rows || []) {
    scanned += 1;
    if (NOT_INBOX.has(row.notification_type)) continue;
    const actionKey = requiredActionKey(row.notification_type);
    const key = actionKey
      ? `required_action:${actionKey}`
      : `${canonicalNoticeType(row.notification_type) || 'update'}:${row.booking_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notifications.push(formatNotification(row, announcements));
    if (notifications.length >= PAGE) break;
  }
  const last = (rows || [])[scanned - 1];
  const hasMore = scanned < (rows || []).length || (rows || []).length === SCAN;

  return res.status(200).json({
    notifications,
    unreadCount: notifications.filter(item => !item.read).length,
    // Where the next page starts; null when this is the oldest.
    nextBefore: hasMore && last ? last.sent_at : null,
  });
}
