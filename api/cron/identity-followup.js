import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendSms } from '../_sms.js';
import { logCron } from './_cron-logger.js';
import { buildIdentityResumeUrl, ensureIdentityResumeToken, OPEN_APPLICATION_STATUSES } from '../_assembler-onboarding.js';
import {
  IDENTITY_FOLLOWUP_OWNER_TYPE,
  IDENTITY_FOLLOWUP_TYPE,
  buildIdentityFollowupEmail,
  buildIdentityFollowupSms,
  identityActivityAnchorMs,
  identityFollowupKey,
  identityFollowupOwnerKey,
  identityFollowupStage,
  isAwaitingIdentity,
  nextIdentityFollowup,
} from '../_identity-followup.js';

/**
 * GET /api/cron/identity-followup, daily.
 *
 * Applicants who signed the contractor agreement but have not finished Stripe
 * Identity get up to three reminders (1, 3 and 7 days after their last ID
 * activity), by email and by text when they agreed to texts, each with a fresh
 * 72-hour link. After the last reminder the owner gets one email so a person can
 * call. Each send is keyed (identity-followup:<profile>:<n>), so overlapping runs
 * or retries never send it twice. This NEVER marks anyone verified: only Stripe's
 * verified webhook does. A session Stripe shows as verified that our profile does
 * not is reported to the owner, not written.
 */
const SENT_STATUSES = ['provider_accepted', 'sent', 'delivered', 'delivery_delayed'];
const PROFILE_SELECT = 'id, role, full_name, email, phone, city, zip, application_status, account_closure_status, contractor_agreement_signed_at, identity_verified, id_verification_status, stripe_identity_session_id, stripe_verification_id, identity_resume_token, identity_resume_token_expires_at, sms_consent_at, sms_opted_out_at, created_at';

/** { count, lastSentMs }: distinct reminders delivered to this applicant, and when the latest went out. */
async function followupsSent(sb, profileId) {
  const { data, error } = await sb.from('notification_log')
    .select('notification_key, status, sent_at')
    .eq('notification_type', IDENTITY_FOLLOWUP_TYPE)
    .eq('recipient_user_id', profileId)
    .in('status', SENT_STATUSES);
  if (error) throw error;
  const numbers = new Set();
  let lastSentMs = null;
  for (const row of data || []) {
    const m = String(row.notification_key || '').match(/identity-followup:[^:]+:(\d+)/);
    if (!m) continue;
    numbers.add(Number(m[1]));
    const at = Date.parse(row.sent_at || '');
    if (Number.isFinite(at) && (lastSentMs === null || at > lastSentMs)) lastSentMs = at;
  }
  return { count: numbers.size, lastSentMs };
}

async function alertOwner(profile, stage, reason) {
  return sendEmail({
    to: ownerEmail(),
    subject: `Applicant stuck at ID verification: ${esc(profile.full_name || 'Easer applicant')}`,
    html: `<p><strong>${esc(profile.full_name || 'Applicant')}</strong> (${esc(profile.city || '')} ${esc(profile.zip || '')}) has not finished identity verification.</p>
      <p>Stage: ${esc(stage)}. ${esc(reason)}</p>
      <p>Email: ${esc(profile.email || '')}${profile.phone ? ` &middot; Phone: ${esc(profile.phone)}` : ''}</p>
      <p>Signed the contractor agreement ${esc(String(profile.contractor_agreement_signed_at || '').slice(0, 10))}.</p>`,
    meta: { notificationType: IDENTITY_FOLLOWUP_OWNER_TYPE, recipientType: 'owner', notificationKey: identityFollowupOwnerKey(profile.id) },
  });
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const startedAt = Date.now();
  const sb = getSupabase();
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const result = { checked: 0, reminded: 0, ownerAlerts: 0, skipped: [], failed: [] };

  try {
    const { data: profiles, error } = await sb.from('profiles')
      .select(PROFILE_SELECT)
      .eq('role', 'assembler')
      .in('application_status', OPEN_APPLICATION_STATUSES)
      .not('contractor_agreement_signed_at', 'is', null)
      .or('identity_verified.is.null,identity_verified.eq.false');
    if (error) throw error;

    for (const profile of (profiles || []).filter(isAwaitingIdentity)) {
      result.checked += 1;
      try {
        const sessionId = profile.stripe_identity_session_id || profile.stripe_verification_id;
        let session = null;
        let sessionLookupFailed = false;
        if (sessionId) {
          if (!stripe) sessionLookupFailed = true;
          else {
            try { session = await stripe.identity.verificationSessions.retrieve(sessionId); }
            catch { sessionLookupFailed = true; }
          }
        }
        const stage = identityFollowupStage(profile, session, { sessionLookupFailed });
        if (stage === 'unknown' || stage === 'in_review') { result.skipped.push({ id: profile.id, stage }); continue; }
        if (stage === 'verified_unrecorded') {
          const sent = await alertOwner(profile, stage, 'Stripe shows this ID check verified, but the profile does not. Check the Stripe webhook before approving.');
          if (sent?.ok !== false) result.ownerAlerts += 1;
          continue;
        }

        const { count: sentCount, lastSentMs } = await followupsSent(sb, profile.id);
        const next = nextIdentityFollowup({ anchorMs: identityActivityAnchorMs(profile, session), sentCount, lastSentMs, nowMs: Date.now() });
        if (!next) { result.skipped.push({ id: profile.id, stage, why: sentCount >= 3 ? 'reminders_done' : 'not_due' }); continue; }

        const token = await ensureIdentityResumeToken(sb, profile, { rotate: true });
        const url = buildIdentityResumeUrl(token);
        const expiresAt = new Date(Date.now() + 72 * 3600000).toISOString();
        const notificationKey = identityFollowupKey(profile.id, next.number);
        const { subject, html } = buildIdentityFollowupEmail({ fullName: profile.full_name, stage, url, esc });
        const email = profile.email ? await sendEmail({
          to: profile.email, subject, html, replyTo: ownerEmail(),
          meta: { notificationType: IDENTITY_FOLLOWUP_TYPE, recipientType: 'easer', recipientUserId: profile.id, notificationKey, expiresAt },
        }) : { ok: false, skipped: 'no_email' };
        const sms = await sendSms({
          recipient: profile,
          body: buildIdentityFollowupSms({ stage, url }),
          meta: { notificationType: IDENTITY_FOLLOWUP_TYPE, recipientType: 'easer', recipientUserId: profile.id, notificationKey, routine: false, expiresAt },
        });
        if (email?.ok !== false || sms?.ok) result.reminded += 1;
        else result.failed.push({ id: profile.id, email: email?.skipped || email?.error || 'failed', sms: sms?.skipped || sms?.error || 'failed' });

        if (next.isLast) {
          const sent = await alertOwner(profile, stage, `Three reminders sent (days 1, 3 and 7). A call may get this finished.`);
          if (sent?.ok !== false) result.ownerAlerts += 1;
        }
      } catch (err) {
        result.failed.push({ id: profile.id, error: String(err?.message || err).slice(0, 200) });
      }
    }

    await logCron('identity-followup', { status: result.failed.length ? 'error' : 'ok', records: result.reminded + result.ownerAlerts, duration: Date.now() - startedAt, errorText: result.failed.length ? JSON.stringify(result.failed).slice(0, 500) : null });
    return res.status(200).json(result);
  } catch (err) {
    await logCron('identity-followup', { error: String(err?.message || err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Identity follow-up failed', ...result });
  }
}
