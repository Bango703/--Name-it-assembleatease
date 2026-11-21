/**
 * Identity follow-up for Easer applicants (owner, 2026-11-20: "easers seem to
 * stop at identity verification").
 *
 * Production, 2026-11-20: of the open applicants, two had signed the contractor
 * agreement and never opened the ID check, and two had started it and quit.
 * Stripe marks a quit session `requires_input` with last_error `abandoned` but
 * sends no webhook for it, so the profile kept saying `pending`, nobody was told,
 * and the only link the applicant ever got (in the application email) expired
 * after 72 hours. This module decides, from the profile and Stripe's own session
 * status, who is waiting on the ID step and when the next reminder is due. It
 * never changes verification state: only Stripe's verified webhook does that.
 */
import { OPEN_APPLICATION_STATUSES } from './_assembler-onboarding.js';

/** Reminders go out this many days after the applicant's last ID activity. */
export const IDENTITY_FOLLOWUP_DAYS = Object.freeze([1, 3, 7]);
export const IDENTITY_FOLLOWUP_TYPE = 'identity_resume_followup';
export const IDENTITY_FOLLOWUP_OWNER_TYPE = 'identity_followup_owner';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Is this profile an open applicant whose application waits on the ID step? */
export function isAwaitingIdentity(profile = {}) {
  if (!profile || profile.role && profile.role !== 'assembler') return false;
  if (profile.identity_verified === true) return false;
  if (profile.account_closure_status) return false;
  if (!profile.contractor_agreement_signed_at) return false;
  const status = String(profile.application_status || '').trim().toLowerCase();
  return OPEN_APPLICATION_STATUSES.includes(status);
}

/**
 * Where the applicant is, from Stripe's answer (Rule 5: Stripe is the truth for
 * the session). `session` is the retrieved VerificationSession or null.
 *   not_started           no session was ever opened
 *   started_not_finished  Stripe says requires_input (quit, failed check) or canceled
 *   in_review             Stripe is still processing the documents
 *   verified_unrecorded   Stripe verified it but our profile does not say so
 *   unknown               the session could not be read; do nothing
 */
export function identityFollowupStage(profile = {}, session = null, { sessionLookupFailed = false } = {}) {
  const sessionId = profile.stripe_identity_session_id || profile.stripe_verification_id || null;
  if (!sessionId) return 'not_started';
  if (sessionLookupFailed || !session) return 'unknown';
  if (session.status === 'verified') return 'verified_unrecorded';
  if (session.status === 'processing') return 'in_review';
  if (session.status === 'requires_input' || session.status === 'canceled') return 'started_not_finished';
  return 'unknown';
}

/** Latest moment the applicant did something on the ID step (ms). */
export function identityActivityAnchorMs(profile = {}, session = null) {
  const times = [Date.parse(profile.contractor_agreement_signed_at || '')];
  if (session && Number.isFinite(session.created)) times.push(session.created * 1000);
  const valid = times.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : NaN;
}

/**
 * Next reminder due, or null. `sentCount` is how many follow-ups this applicant
 * already received and `lastSentMs` when the latest one went out. Each reminder
 * is due IDENTITY_FOLLOWUP_DAYS[n] days after the anchor AND no sooner than the
 * planned gap after the previous reminder (2 days, then 4). Without the gap, an
 * applicant who stalled weeks ago is past every date at once and would get three
 * reminders on three days running. Nothing goes out after the last one.
 */
export function nextIdentityFollowup({ anchorMs, sentCount = 0, nowMs = Date.now(), lastSentMs = null } = {}) {
  if (!Number.isFinite(anchorMs) || sentCount >= IDENTITY_FOLLOWUP_DAYS.length) return null;
  const dueAt = anchorMs + IDENTITY_FOLLOWUP_DAYS[sentCount] * DAY_MS;
  if (nowMs < dueAt) return null;
  if (sentCount > 0 && Number.isFinite(lastSentMs)) {
    const gapDays = IDENTITY_FOLLOWUP_DAYS[sentCount] - IDENTITY_FOLLOWUP_DAYS[sentCount - 1];
    if (nowMs < lastSentMs + gapDays * DAY_MS) return null;
  }
  return { number: sentCount + 1, isLast: sentCount + 1 === IDENTITY_FOLLOWUP_DAYS.length };
}

export const identityFollowupKey = (profileId, number) => `identity-followup:${profileId}:${number}`;
export const identityFollowupOwnerKey = (profileId) => `identity-followup-owner:${profileId}`;

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'there';
}

/** Applicant email: the fact and the action (seat 15: no processor names, no reasons). */
export function buildIdentityFollowupEmail({ fullName, stage, url, esc }) {
  const started = stage === 'started_not_finished';
  const subject = started ? 'Finish your ID verification' : 'One step left: verify your ID';
  const lead = started
    ? 'Your ID verification was started but not finished.'
    : 'Your Easer application is waiting on one step: a photo of your ID and a selfie.';
  const html = `
    <p style="margin:0 0 14px;font-size:15px;color:#1f2933">Hi ${esc(firstName(fullName))},</p>
    <p style="margin:0 0 18px;font-size:15px;color:#1f2933;line-height:1.6">${esc(lead)}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:#00BFFF;border-radius:8px">
      <a href="${esc(url)}" style="display:inline-block;padding:13px 28px;color:#001f2b;font-size:14px;font-weight:800;text-decoration:none">${started ? 'Finish ID verification' : 'Verify my ID'}</a>
    </td></tr></table>
    <p style="margin:0 0 6px;font-size:13px;color:#52606d">This link works for 72 hours.</p>
    <p style="margin:18px 0 0;font-size:14px;color:#1f2933">The AssembleAtEase Team</p>`;
  return { subject, html };
}

export function buildIdentityFollowupSms({ stage, url }) {
  return stage === 'started_not_finished'
    ? `AssembleAtEase: your ID verification was started but not finished. Finish it here: ${url}`
    : `AssembleAtEase: your Easer application has one step left, ID verification. Verify here: ${url}`;
}
