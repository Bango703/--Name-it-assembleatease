// Ask an offline Easer to go online for a job (owner, 2026-10-29: Luis Munoz
// had every job requirement done but was offline, so he was missing from the
// assign list and the owner had no way to reach him from the dashboard).
//
// The owner picks the Easer and the job. The Easer gets an app notice and an
// email, plus a text when job texts are on, naming the service, city, day and
// time, never the customer. Requests are activity_logs rows
// (easer_go_online_requested, actor_id = Easer, booking_id = the job), so there
// is no migration. When the Easer comes online the expire-offers cron tells the
// owner once (easer_go_online_answered, metadata.requestId).
import { sendSms } from './_sms.js';
import { sendEmail, ownerEmail, esc } from './_email.js';
import { sendPushToUser } from './_push.js';
import { logActivity } from './booking/_activity.js';
import { getEaserReadiness } from './_easer-readiness.js';
import { normalizeAssemblerProfile } from './_assembler-state.js';
import { isDemoEaser } from './_demo-accounts.js';
import { chicagoDateIso } from './_source-of-truth.js';
import { formatAppointmentDate, formatAppointmentDateShort, formatSlotShort } from './booking/_appt-date.js';

export const GO_ONLINE_ANSWER_WINDOW_HOURS = 48;
const SITE = 'https://www.assembleatease.com';
const ONLINE_ITEM = 'Online and available';

/** Ready for offers except that they are offline: the only Easers worth asking. */
export function onlyOfflineBlocks(readiness) {
  const missing = readiness?.missingItems || [];
  return readiness?.isReady !== true && missing.length > 0 && missing.every(item => item === ONLINE_ITEM);
}

/**
 * Whether another Easer can take this job. Mirrors the owner dashboard: an
 * owner-created job is the owner-Easer's own unless it is a verified Thumbtack
 * job, and a job in the past is not worth asking anyone online for.
 */
export function bookingTakesAskedEaser(booking, { todayIso = chicagoDateIso() } = {}) {
  if (!booking || booking.status !== 'confirmed') return false;
  if (booking.is_test_booking === true) return false;
  if (String(booking.date || '').slice(0, 10) < todayIso) return false;
  if (booking.source === 'owner_manual') {
    return booking.payment_method === 'thumbtack'
      && booking.external_platform === 'thumbtack'
      && booking.payment_status === 'offline_recorded'
      && Boolean(booking.external_agreement_verified_at);
  }
  return true;
}

/** What the job is, in words the Easer can act on. No customer details. */
export function describeJobForEaser(booking) {
  const service = String(booking.service || 'An assembly').trim();
  const city = String(booking.service_city || '').trim();
  const isoDay = String(booking.date || '').slice(0, 10);
  const time = String(booking.time || '').trim();
  return {
    service, city, time,
    day: formatAppointmentDate(isoDay),
    shortDay: formatAppointmentDateShort(isoDay),
    shortTime: formatSlotShort(time),
  };
}

// One segment at worst case with the STOP line (scripts/test-sms-message-length.mjs),
// and no link: carriers have blocked linked texts to Easers.
// Owner-created jobs carry a free-text service name, so both names are capped.
export function buildGoOnlineSms(job) {
  const service = job.service.slice(0, 24).trim();
  const city = job.city.slice(0, 18).trim();
  return `AssembleAtEase: ${service} job${city ? ` in ${city}` : ''}, ${job.shortDay}${job.shortTime ? ` ${job.shortTime}` : ''}. Go Online in the Easer app to get it.`;
}

function buildGoOnlineEmailHtml(firstName, job) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0d1b2a">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
    <div style="padding:22px 24px;border-bottom:3px solid #00BFFF">
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#00BFFF">A job is waiting for you</div>
      <div style="font-size:20px;font-weight:800;margin-top:6px">${esc(firstName)}, AssembleAtEase has a job for you.</div>
    </div>
    <div style="padding:24px">
      <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 12px"><strong>${esc(job.service)}</strong>${job.city ? ` in ${esc(job.city)}` : ''} on ${esc(job.day)}${job.time ? `, ${esc(job.time)}` : ''}.</p>
      <p style="font-size:14px;line-height:1.7;color:#334155;margin:0 0 4px">You are offline, so it cannot be sent to you yet. Open the app and go <strong>Online</strong>, and AssembleAtEase can send it to you to accept.</p>
      <p style="margin:22px 0 4px"><a href="${SITE}/assembler/" style="display:inline-block;background:#00BFFF;color:#04222c;font-weight:800;text-decoration:none;padding:12px 24px;border-radius:999px">Open the app &amp; go Online</a></p>
      <p style="font-size:13px;line-height:1.6;color:#64748b;margin:14px 0 0">Can't take it? Reply to this email so AssembleAtEase can offer it to someone else.</p>
    </div>
  </div>
</div></body></html>`;
}

/**
 * Send the request. Fails closed: refuses unless the job can take this Easer,
 * the Easer is ready except for being offline, and they were not already asked
 * for this job. Records the request only if at least one channel went out.
 */
export async function requestEaserGoOnline(sb, { easerId, bookingId, nowMs = Date.now() }) {
  const fail = (status, code, error) => ({ ok: false, status, code, error });

  const { data: booking, error: bookingError } = await sb.from('bookings')
    .select('id, ref, service, service_city, date, time, status, source, payment_method, payment_status, external_platform, external_agreement_verified_at, is_test_booking, assembler_id')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingError) return fail(503, 'BOOKING_READ_FAILED', 'The job could not be read. Nothing was sent.');
  if (!booking) return fail(404, 'BOOKING_NOT_FOUND', 'Job not found.');
  if (!bookingTakesAskedEaser(booking, { todayIso: chicagoDateIso(new Date(nowMs)) })) {
    return fail(409, 'BOOKING_NOT_ASSIGNABLE', 'This job cannot be given to another Easer right now, so nobody was asked.');
  }
  if (booking.assembler_id === easerId) return fail(409, 'ALREADY_ASSIGNED', 'This Easer already has this job.');

  const { data: rawProfile, error: profileError } = await sb.from('profiles')
    .select('*')
    .eq('id', easerId)
    .eq('role', 'assembler')
    .maybeSingle();
  if (profileError) return fail(503, 'EASER_READ_FAILED', 'The Easer could not be read. Nothing was sent.');
  if (!rawProfile) return fail(404, 'EASER_NOT_FOUND', 'Easer not found.');
  if (rawProfile.is_owner === true) return fail(409, 'OWNER_EASER', 'That is your own Easer account.');
  if (await isDemoEaser(sb, easerId)) return fail(409, 'DEMO_EASER', 'Demo accounts are never asked to take real jobs.');
  if (rawProfile.is_available === true) {
    return fail(409, 'EASER_ALREADY_ONLINE', `${rawProfile.full_name || 'This Easer'} is already online. Refresh and assign them.`);
  }
  const readiness = await getEaserReadiness(normalizeAssemblerProfile(rawProfile));
  if (!onlyOfflineBlocks(readiness)) {
    return fail(409, 'EASER_NOT_READY', `Going online would not be enough: ${(readiness.missingItems || []).filter(i => i !== ONLINE_ITEM).join(', ') || 'setup is not complete'}.`);
  }

  const { data: asked, error: askedError } = await sb.from('activity_logs')
    .select('id, created_at')
    .eq('event_type', 'easer_go_online_requested')
    .eq('booking_id', bookingId)
    .eq('actor_id', easerId)
    .limit(1);
  if (askedError) return fail(503, 'REQUEST_READ_FAILED', 'Earlier requests could not be read. Nothing was sent.');
  if (asked?.length) {
    const when = new Date(asked[0].created_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return fail(409, 'ALREADY_ASKED', `${rawProfile.full_name || 'This Easer'} was already asked about this job on ${when}.`);
  }

  const job = describeJobForEaser(booking);
  const firstName = String(rawProfile.full_name || 'there').trim().split(/\s+/)[0] || 'there';
  const meta = { bookingId, notificationType: 'easer_go_online_request', recipientType: 'easer', recipientUserId: easerId };

  // Texts only with job texts on and never after STOP; sendSms enforces it.
  const sms = await sendSms({
    recipient: { id: easerId, phone: rawProfile.phone, sms_consent_at: rawProfile.sms_consent_at, sms_opted_out_at: rawProfile.sms_opted_out_at },
    body: buildGoOnlineSms(job),
    meta,
  }).catch(e => ({ ok: false, error: e?.message || String(e) }));
  const email = rawProfile.email
    ? await sendEmail({
      to: rawProfile.email,
      subject: `A job is waiting for you — go Online (${job.service}${job.city ? `, ${job.city}` : ''})`,
      html: buildGoOnlineEmailHtml(firstName, job),
      replyTo: ownerEmail(),
      meta,
    }).catch(e => ({ ok: false, error: e?.message || String(e) }))
    : { ok: false, skipped: 'no_email' };
  const push = await sendPushToUser(easerId, {
    title: 'A job is waiting for you',
    body: `${job.service}${job.city ? ` in ${job.city}` : ''} on ${job.shortDay}. Go online to get it.`,
    url: '/assembler/',
  }, meta).catch(e => ({ ok: false, error: e?.message || String(e) }));

  const channels = {
    text: sms?.ok === true,
    email: email?.ok === true && !email?.suppressed,
    app: push?.ok === true,
  };
  if (!channels.text && !channels.email) {
    return fail(502, 'GO_ONLINE_NOT_SENT', 'Neither the text nor the email went out, so no request was recorded. Try again.');
  }

  await logActivity(sb, {
    bookingId,
    eventType: 'easer_go_online_requested',
    actorType: 'owner',
    actorId: easerId,
    actorName: 'Owner',
    description: `Asked ${rawProfile.full_name || easerId} to go online for ${booking.ref || 'this job'} (${[channels.text && 'text', channels.email && 'email', channels.app && 'app'].filter(Boolean).join(', ')}).`,
    metadata: { easerId, channels, smsSkipped: sms?.skipped || null },
  }).catch(e => console.error('go-online request logActivity error:', e?.message || e));

  return { ok: true, channels, smsSkipped: sms?.skipped || null, easerName: rawProfile.full_name || null };
}

/**
 * Requests whose Easer is now online and the owner has not been told.
 * requests: [{ id, booking_id, actor_id, created_at }]; answeredIds: Set of
 * request ids already reported; online: Set of Easer ids online now.
 */
export function pendingGoOnlineAnswers(requests, answeredIds, online, { nowMs = Date.now() } = {}) {
  const since = nowMs - GO_ONLINE_ANSWER_WINDOW_HOURS * 3600000;
  return (requests || []).filter(r => !answeredIds.has(r.id)
    && Date.parse(r.created_at) >= since
    && online.has(r.actor_id));
}

/** Cron step: tell the owner, once per request, that an asked Easer is online. */
export async function notifyOwnerOfOnlineEasers(sb, { nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - GO_ONLINE_ANSWER_WINDOW_HOURS * 3600000).toISOString();
  const { data: requests, error } = await sb.from('activity_logs')
    .select('id, booking_id, actor_id, created_at')
    .eq('event_type', 'easer_go_online_requested')
    .gte('created_at', since);
  if (error) throw new Error(`Go-online requests could not be read: ${error.message}`);
  if (!requests?.length) return { told: 0 };

  const { data: answered, error: answeredError } = await sb.from('activity_logs')
    .select('metadata')
    .eq('event_type', 'easer_go_online_answered')
    .gte('created_at', since);
  if (answeredError) throw new Error(`Go-online answers could not be read: ${answeredError.message}`);
  const answeredIds = new Set((answered || []).map(r => r.metadata?.requestId).filter(Boolean));

  const easerIds = [...new Set(requests.map(r => r.actor_id).filter(Boolean))];
  const { data: profiles, error: profileError } = await sb.from('profiles')
    .select('id, full_name, is_available')
    .in('id', easerIds);
  if (profileError) throw new Error(`Easers could not be read: ${profileError.message}`);
  const online = new Set((profiles || []).filter(p => p.is_available === true).map(p => p.id));
  const names = new Map((profiles || []).map(p => [p.id, p.full_name]));

  const due = pendingGoOnlineAnswers(requests, answeredIds, online, { nowMs });
  if (!due.length) return { told: 0 };
  const { data: bookings } = await sb.from('bookings')
    .select('id, ref, service, date, time, status, assembler_id')
    .in('id', [...new Set(due.map(r => r.booking_id))]);
  const byId = new Map((bookings || []).map(b => [b.id, b]));

  let told = 0;
  for (const r of due) {
    const b = byId.get(r.booking_id) || {};
    const name = names.get(r.actor_id) || 'The Easer';
    const open = b.status === 'confirmed' && !b.assembler_id;
    const sent = await sendEmail({
      to: ownerEmail(),
      subject: `${name} is online${open ? ` — assign ${b.ref || 'the job'}` : ''}`,
      html: `<p><strong>${esc(name)}</strong> went online after you asked them about <strong>${esc(b.ref || 'a job')}</strong> (${esc(b.service || 'job')}, ${esc(formatAppointmentDate(String(b.date || '').slice(0, 10)))}${b.time ? `, ${esc(b.time)}` : ''}).</p>
        <p>${open ? 'The job is still unassigned. Open it in the owner dashboard and assign them.' : 'The job is no longer waiting for an Easer, so there is nothing to assign.'}</p>`,
      meta: { bookingId: r.booking_id, notificationType: 'owner_easer_online_notice', recipientType: 'owner', disableDedupe: true },
    }).catch(e => ({ ok: false, error: e?.message || String(e) }));
    if (!sent?.ok) continue; // told next run instead
    await logActivity(sb, {
      bookingId: r.booking_id,
      eventType: 'easer_go_online_answered',
      actorType: 'system',
      actorId: r.actor_id,
      actorName: 'System',
      description: `${name} went online after being asked about ${b.ref || 'this job'}.`,
      metadata: { requestId: r.id, easerId: r.actor_id, jobStillOpen: open },
    }).catch(e => console.error('go-online answered logActivity error:', e?.message || e));
    told += 1;
  }
  return { told };
}
