import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc, formatAddress } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { notificationAppointmentTimestampMs, formatAppointmentDate } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';
import { formatUsPhone } from '../_phone.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';

/**
 * GET /api/cron/no-show-check  — runs every 30 min.
 *
 * Detects likely Easer no-shows: a booking an Easer ACCEPTED but that never
 * progressed to 'arrived'/'in_progress' by well past its appointment start.
 * Alerts the owner once per appointment/acceptance (deduped by successful
 * notification records and a durable provider-send event key)
 * so the owner can call the Easer or re-dispatch. Intentionally does NOT
 * auto-re-dispatch — a late Easer is not always a no-show, and sending a
 * second Easer risks two pros at one home. Owner stays in control (launch mode).
 */
const GRACE_MINUTES = 60;          // minutes past appointment start before flagging
const LOOKBACK_DAYS  = 3;          // ignore appointments older than this (avoid ancient noise)

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
  const sb = getSupabase();
  const now = Date.now();
  const lookbackDate = new Date(now - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  // Candidates: an Easer accepted (assembler_accepted_at set) but the job is still
  // sitting in confirmed/en_route — never marked arrived/in_progress/completed.
  const { data: candidates, error } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_email, customer_phone, address, service_zip, service_city, date, time, status, assembler_id, assembler_name, assembler_accepted_at, return_visit_required')
    .in('status', [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE])
    .not('assembler_accepted_at', 'is', null)
    .gte('date', lookbackDate)
    .limit(100);

  if (error) {
    console.error('no-show-check query error:', error);
    await logCron('no-show-check', { status: 'error', error: error.message, duration: Date.now() - t });
    return res.status(500).json({ error: 'Query failed' });
  }

  const assemblerIds = Array.from(new Set((candidates || []).map(b => b.assembler_id).filter(Boolean)));
  let assemblerPhonesById = {};
  if (assemblerIds.length) {
    try {
      const { data: profiles, error: profileErr } = await sb
        .from('profiles')
        .select('id, phone')
        .in('id', assemblerIds);
      if (profileErr) {
        console.error('no-show-check profile phone query error:', profileErr);
      } else {
        assemblerPhonesById = Object.fromEntries((profiles || []).map(p => [p.id, p.phone || null]));
      }
    } catch (profileEx) {
      console.error('no-show-check profile phone lookup exception:', profileEx);
    }
  }

  let flagged = 0;
  let failed = 0;
  let deferred = 0;
  const flaggedRefs = [];

  for (const b of candidates || []) {
    if (b.return_visit_required === true) continue;
    const apptMs = notificationAppointmentTimestampMs(b);
    if (apptMs == null) continue;                          // unparseable time → skip (conservative)
    if (now < apptMs + GRACE_MINUTES * 60000) continue;    // not past grace yet

    // A legacy activity marker was written even after a failed send. Only a
    // successful owner email for this appointment/acceptance can stop retries.
    try {
      const { data: prior } = await sb
        .from('notification_log')
        .select('id')
        .eq('booking_id', b.id)
        .eq('channel', 'email')
        .eq('notification_type', 'no_show_alert')
        .eq('recipient_type', 'owner')
        .in('status', ['provider_accepted', 'sent', 'delivered', 'delivery_delayed'])
        .gte('sent_at', new Date(Math.max(apptMs, Date.parse(b.assembler_accepted_at) || 0)).toISOString())
        .limit(1);
      if (prior && prior.length) continue;
    } catch (e) {
      // Log lookup unavailable: the shared sender still reserves the event.
      console.warn('no-show dedup check skipped:', e.message);
    }

    const minsLate = Math.round((now - apptMs) / 60000);
    const easer = esc(b.assembler_name || 'the assigned Easer');
    const easerPhoneRaw = assemblerPhonesById[b.assembler_id] || null;
    const easerPhone = formatUsPhone(easerPhoneRaw);
    const customerPhone = formatUsPhone(b.customer_phone);

    try {
      // Recheck the appointment/assignment immediately before the send. A scan
      // is only a snapshot: arrival, cancellation or reassignment may have won.
      const { data: current, error: currentError } = await sb.from('bookings')
        .select('id')
        .eq('id', b.id)
        .in('status', [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE])
        .eq('assembler_id', b.assembler_id)
        .eq('assembler_accepted_at', b.assembler_accepted_at)
        .eq('date', b.date)
        .eq('time', b.time)
        .is('checked_in_at', null)
        .or('return_visit_required.is.null,return_visit_required.eq.false')
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current) continue;
      const notificationKey = ['no-show', b.id, b.date, b.time, b.assembler_id, b.assembler_accepted_at].join(':');
      const result = await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase System <booking@assembleatease.com>',
        subject: `Possible no-show — ${b.ref} (${easer})`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;border-top:4px solid #dc2626"><tr><td style="padding:24px">
    <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#dc2626">Possible No-Show — Action Needed</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700">${esc(b.ref)} &bull; ${esc(b.service)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.7">
      <strong>${easer}</strong> accepted this job but it is still <strong>${esc(b.status)}</strong> &mdash; not marked arrived or in progress &mdash; about <strong>${minsLate} minutes</strong> past the appointment start. The customer may be waiting.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;font-size:14px;margin-bottom:18px"><tr><td style="padding:14px 18px">
      <table width="100%"><tr><td style="padding:4px 0;color:#71717a;width:90px">Customer</td><td style="padding:4px 0">${esc(b.customer_name || '')}${customerPhone ? ' &bull; <a href="tel:' + esc(b.customer_phone) + '" style="color:#00BFFF">' + esc(customerPhone) + '</a>' : ''}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">Easer</td><td style="padding:4px 0">${easer}${easerPhone ? ' &bull; <a href="tel:' + esc(easerPhoneRaw) + '" style="color:#00BFFF">' + esc(easerPhone) + '</a>' : ''}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">When</td><td style="padding:4px 0">${esc(formatAppointmentDate(b.date))} at ${esc(b.time)}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">Address</td><td style="padding:4px 0">${esc(formatAddress(b.address || ''))}</td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0 0 4px;font-size:13px;color:#52525b;line-height:1.7"><strong>What to do:</strong> Call the Easer first. If they can't make it, reassign the job from your dashboard.</p>
    <a href="https://www.assembleatease.com/owner/" style="display:inline-block;margin-top:12px;background:#00BFFF;color:#fff;padding:11px 26px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">Open Dashboard</a>
  </td></tr></table>
</div></body></html>`,
        replyTo: ownerEmail(),
        meta: { bookingId: b.id, notificationType: 'no_show_alert', recipientType: 'owner', notificationKey, routine: false },
      });

      if (!result?.ok) {
        if (result?.deferred) { deferred++; continue; }
        failed++;
        await logActivity(sb, {
          bookingId: b.id, eventType: 'no_show_alert_failed', actorType: 'system', actorName: 'no_show_check',
          description: 'Possible no-show needs attention; owner email delivery was not confirmed. Review the delivery log.',
          metadata: { notificationKey, error: result?.error || result?.reason || 'send_failed', assemblerId: b.assembler_id },
        });
        continue;
      }
      if (result.suppressed) continue;

      await logActivity(sb, {
        bookingId: b.id,
        eventType: 'no_show_flagged',
        actorType: 'system',
        actorName: 'no_show_check',
        description: `Possible no-show: ${b.assembler_name || 'Easer'} accepted but job still ${b.status} ${minsLate} min past appointment start. Owner email accepted for delivery.`,
        metadata: { minsLate, status: b.status, assemblerId: b.assembler_id, notificationKey },
      });

      flagged++;
      flaggedRefs.push(b.ref);
    } catch (e) {
      failed++;
      console.error('no-show alert error for ' + b.ref + ':', e);
    }
  }

  await logCron('no-show-check', { status: failed ? 'error' : 'ok', records: flagged, errorText: failed ? `${failed} owner notice(s) failed; retry required` : null, duration: Date.now() - t });
  return res.status(200).json({ flagged, failed, deferred, refs: flaggedRefs });
}
