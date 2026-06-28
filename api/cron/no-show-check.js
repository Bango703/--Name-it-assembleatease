import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { appointmentTimestampMs } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/no-show-check  — runs every 30 min.
 *
 * Detects likely Easer no-shows: a booking an Easer ACCEPTED but that never
 * progressed to 'arrived'/'in_progress' by well past its appointment start.
 * Alerts the owner ONCE (deduped via an activity_logs 'no_show_flagged' event)
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
    .select('id, ref, service, customer_name, customer_email, customer_phone, address, date, time, status, assembler_id, assembler_name, assembler_accepted_at')
    .in('status', ['confirmed', 'en_route'])
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
  const flaggedRefs = [];

  for (const b of candidates || []) {
    const apptMs = appointmentTimestampMs(b.date, b.time);
    if (apptMs == null) continue;                          // unparseable time → skip (conservative)
    if (now < apptMs + GRACE_MINUTES * 60000) continue;    // not past grace yet

    // Fire exactly once per booking: skip if we already flagged it.
    try {
      const { data: prior } = await sb
        .from('activity_logs')
        .select('id')
        .eq('booking_id', b.id)
        .eq('event_type', 'no_show_flagged')
        .limit(1);
      if (prior && prior.length) continue;
    } catch (e) {
      // activity_logs unavailable — fall back to email-system dedup below.
      console.warn('no-show dedup check skipped:', e.message);
    }

    const minsLate = Math.round((now - apptMs) / 60000);
    const easer = esc(b.assembler_name || 'the assigned Easer');
    const easerPhone = assemblerPhonesById[b.assembler_id] ? esc(assemblerPhonesById[b.assembler_id]) : null;

    try {
      await sendEmail({
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
      <table width="100%"><tr><td style="padding:4px 0;color:#71717a;width:90px">Customer</td><td style="padding:4px 0">${esc(b.customer_name || '')}${b.customer_phone ? ' &bull; <a href="tel:' + esc(b.customer_phone) + '" style="color:#00BFFF">' + esc(b.customer_phone) + '</a>' : ''}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">Easer</td><td style="padding:4px 0">${easer}${easerPhone ? ' &bull; <a href="tel:' + easerPhone + '" style="color:#00BFFF">' + easerPhone + '</a>' : ''}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">When</td><td style="padding:4px 0">${esc(b.date)} at ${esc(b.time)}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">Address</td><td style="padding:4px 0">${esc(b.address || '')}</td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0 0 4px;font-size:13px;color:#52525b;line-height:1.7"><strong>What to do:</strong> Call the Easer first. If they can't make it, reassign the job from your dashboard.</p>
    <a href="https://www.assembleatease.com/owner/" style="display:inline-block;margin-top:12px;background:#00BFFF;color:#fff;padding:11px 26px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">Open Dashboard</a>
  </td></tr></table>
</div></body></html>`,
        replyTo: ownerEmail(),
        meta: { bookingId: b.id, notificationType: 'no_show_alert', recipientType: 'owner' },
      });

      logActivity(sb, {
        bookingId: b.id,
        eventType: 'no_show_flagged',
        actorType: 'system',
        actorName: 'no_show_check',
        description: `Possible no-show: ${b.assembler_name || 'Easer'} accepted but job still ${b.status} ${minsLate} min past appointment start. Owner alerted.`,
        metadata: { minsLate, status: b.status, assemblerId: b.assembler_id },
      });

      flagged++;
      flaggedRefs.push(b.ref);
    } catch (e) {
      console.error('no-show alert error for ' + b.ref + ':', e);
    }
  }

  await logCron('no-show-check', { status: 'ok', records: flagged, duration: Date.now() - t });
  return res.status(200).json({ flagged, refs: flaggedRefs });
}
