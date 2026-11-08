// Inactive Easers: why an Easer counts as inactive, the 14-day notice, and
// whether they answered it (owner, 2026-10-28: Thomas J Williams-Gibson never
// signed the updated agreement, was not online and never accepted a job).
//
// Closing an account only for inactivity is termination without cause, which
// contractor agreement 12.4 allows with 14 days' prior written notice. So the
// owner sends a notice that states the reasons and the date; the dashboard
// offers Deactivate only after that date, and shows when the Easer answered by
// signing the agreement or accepting a job. Notices are activity_logs rows
// (easer_inactivity_notice, actor_id = Easer), so there is no migration.
import { CONTRACTOR_AGREEMENT_VERSION } from './_assembler-onboarding.js';

export const INACTIVITY_NOTICE_DAYS = 14;
export const NO_RECENT_ACCEPT_DAYS = 30;
const DAY_MS = 86400000;

function agreementCurrent(profile = {}) {
  return Boolean(profile.contractor_agreement_signed_at)
    && profile.contractor_agreement_version === CONTRACTOR_AGREEMENT_VERSION;
}

/**
 * The reasons this Easer is inactive, in the words the notice uses. Empty when
 * they are not. history: { acceptedJobs, lastAcceptedAt }.
 */
export function inactivityReasons(profile = {}, history = {}, { nowMs = Date.now() } = {}) {
  const reasons = [];
  if (!agreementCurrent(profile)) {
    reasons.push({ key: 'agreement', text: `You have not signed the updated contractor agreement (version ${CONTRACTOR_AGREEMENT_VERSION}).` });
  }
  const accepted = Number(history.acceptedJobs || 0);
  const last = Date.parse(history.lastAcceptedAt || '');
  if (accepted === 0) {
    reasons.push({ key: 'no_jobs', text: 'You have not accepted any jobs since your account was approved.' });
  } else if (!Number.isFinite(last) || nowMs - last > NO_RECENT_ACCEPT_DAYS * DAY_MS) {
    reasons.push({ key: 'no_recent_jobs', text: `You have not accepted a job in the last ${NO_RECENT_ACCEPT_DAYS} days.` });
  }
  if (profile.is_available !== true) {
    reasons.push({ key: 'offline', text: 'Your account has been offline, so you are not getting job offers.' });
  }
  // Offline on its own is a choice, not inactivity; one of the others must hold.
  return reasons.some(r => r.key !== 'offline') ? reasons : [];
}

/**
 * Where a sent notice stands: open (inside the 14 days), responded (signed the
 * agreement or accepted a job after it was sent), or ended (deadline passed with
 * no response, Deactivate is allowed). null when no notice was sent.
 */
export function inactivityNoticeState(notice, profile = {}, history = {}, { nowMs = Date.now() } = {}) {
  if (!notice?.sentAt) return null;
  const sent = Date.parse(notice.sentAt);
  const deadline = notice.deadline || new Date(sent + INACTIVITY_NOTICE_DAYS * DAY_MS).toISOString();
  const signed = Date.parse(profile.contractor_agreement_signed_at || '');
  const acceptedAt = Date.parse(history.lastAcceptedAt || '');
  const respondedAt = [
    agreementCurrent(profile) && signed > sent ? signed : null,
    acceptedAt > sent ? acceptedAt : null,
  ].filter(Boolean).sort((a, b) => a - b)[0];
  if (respondedAt) return { status: 'responded', sentAt: notice.sentAt, deadline, respondedAt: new Date(respondedAt).toISOString() };
  return { status: nowMs >= Date.parse(deadline) ? 'ended' : 'open', sentAt: notice.sentAt, deadline };
}

/**
 * Map<easerId, { acceptedJobs, lastAcceptedAt }> from every accept on record:
 * dispatch offers and owner assignments both log easer_accepted, and a booking
 * still assigned carries assembler_accepted_at. Reads fail closed (throw): a
 * notice must never go out because a history read failed.
 */
export async function loadJobHistory(sb, easerIds) {
  const ids = [...new Set((easerIds || []).filter(Boolean))];
  const out = new Map(ids.map(id => [id, { acceptedJobs: 0, lastAcceptedAt: null }]));
  if (!ids.length) return out;
  const [logs, bookings] = await Promise.all([
    sb.from('activity_logs').select('booking_id, actor_id, created_at').eq('event_type', 'easer_accepted').in('actor_id', ids),
    sb.from('bookings').select('id, assembler_id, assembler_accepted_at').in('assembler_id', ids).not('assembler_accepted_at', 'is', null),
  ]);
  const failed = [logs, bookings].find(r => r.error);
  if (failed) throw new Error(`Job history could not be read: ${failed.error.message}`);
  const jobs = new Map(ids.map(id => [id, new Set()]));
  const note = (easerId, bookingId, at) => {
    const entry = out.get(easerId);
    if (!entry) return;
    jobs.get(easerId).add(bookingId || at);
    if (at && (!entry.lastAcceptedAt || at > entry.lastAcceptedAt)) entry.lastAcceptedAt = at;
  };
  for (const r of logs.data || []) note(r.actor_id, r.booking_id, r.created_at);
  for (const b of bookings.data || []) note(b.assembler_id, b.id, b.assembler_accepted_at);
  for (const [id, set] of jobs) out.get(id).acceptedJobs = set.size;
  return out;
}

/** Map<easerId, { sentAt, deadline, logId }> of each Easer's latest inactivity notice. */
export async function loadInactivityNotices(sb, easerIds) {
  const ids = [...new Set((easerIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await sb.from('activity_logs')
    .select('id, actor_id, created_at, metadata')
    .eq('event_type', 'easer_inactivity_notice')
    .in('actor_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Inactivity notices could not be read: ${error.message}`);
  const out = new Map();
  for (const r of data || []) {
    out.set(r.actor_id, { sentAt: r.created_at, deadline: r.metadata?.deadline || null, logId: r.id });
  }
  return out;
}

/** The notice email body: the reasons, the date, and how to keep the account. */
export function buildInactivityNoticeHtml({ reasons, deadline, note = null }) {
  // The notice's closing day in Central time (a deadline, not an appointment).
  const closesOn = new Date(deadline).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<p style="color:#52525b;line-height:1.7;margin:0 0 12px">Your AssembleAtEase Easer account has been inactive:</p>
<ul style="color:#52525b;line-height:1.7;margin:0 0 16px;padding-left:20px">${reasons.map(r => `<li>${esc(r.text)}</li>`).join('')}</ul>
${note ? `<p style="color:#52525b;line-height:1.7;margin:0 0 16px">${esc(note)}</p>` : ''}
<p style="color:#52525b;line-height:1.7;margin:0 0 12px">Under section 12.4 of the contractor agreement, this is your ${INACTIVITY_NOTICE_DAYS}-day notice: <strong>if nothing changes by ${esc(closesOn)}, your Easer account will be closed.</strong></p>
<p style="color:#52525b;line-height:1.7;margin:0 0 8px">To keep your account, before ${esc(closesOn)} do any of these in the Easer app: sign the updated contractor agreement, go online, or accept a job. Or reply to this email if you want to stay and need help.</p>
<p style="color:#52525b;line-height:1.7;margin:0">Any earnings you are owed for completed work are paid as usual.</p>`;
}
