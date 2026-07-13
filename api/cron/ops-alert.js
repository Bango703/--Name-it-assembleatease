import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { appointmentTimestampMs } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/ops-alert  — every 30 min.
 *
 * The owner dashboard's Live Ops view already shows everything, but only when
 * the owner is looking at it. This pushes the URGENT, owner-action-required
 * states to email so a problem reaches them even when the dashboard is closed.
 *
 * Pushes (deduped once per booking via an activity_logs 'ops_alert_sent' event):
 *   CRITICAL  today's job, no Pro assigned, appointment within 6 hours
 *   HIGH      needs_manual_dispatch — auto-dispatch gave up, owner must assign
 *   MEDIUM    Pro assigned but hasn't accepted 45+ min after assignment
 *
 * Routine, non-urgent unassigned jobs are left to the auto-dispatch cron.
 */
const NO_ACCEPT_MIN   = 45;
const CRITICAL_WINDOW_HRS = 6;

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
  const sb = getSupabase();
  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString();

  const { data: bookings, error } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_phone, date, time, status, assembler_id, assembler_name, assembler_accepted_at, assigned_at, needs_manual_dispatch')
    .in('status', ['pending', 'confirmed'])
    .gte('date', todayStr)
    .limit(200);

  if (error) {
    console.error('ops-alert query error:', error);
    await logCron('ops-alert', { status: 'error', error: error.message, duration: Date.now() - t });
    return res.status(500).json({ error: 'Query failed' });
  }

  // ── Classify each booking into an urgent issue (or none) ──
  const issues = [];
  for (const b of bookings || []) {
    let issue = null;

    if (b.needs_manual_dispatch && !b.assembler_id && b.status === 'confirmed') {
      issue = { sev: 'HIGH', label: 'Needs manual assignment (auto-dispatch gave up)' };
    } else if (b.date === todayStr && !b.assembler_id && ['pending', 'confirmed'].includes(b.status)) {
      const apptMs = appointmentTimestampMs(b.date, b.time);
      const hrsAway = apptMs != null ? (apptMs - now) / 3600000 : 99;
      if (hrsAway <= CRITICAL_WINDOW_HRS) {
        issue = { sev: 'CRITICAL', label: `Today at ${b.time || 'TBD'} — no Pro assigned, ~${Math.max(0, Math.round(hrsAway))}h away` };
      }
    } else if (b.assembler_id && !b.assembler_accepted_at && b.status === 'confirmed' && b.assigned_at) {
      const mins = (now - new Date(b.assigned_at).getTime()) / 60000;
      if (mins >= NO_ACCEPT_MIN) {
        issue = { sev: 'MEDIUM', label: `${b.assembler_name || 'Assigned Pro'} hasn't accepted — ${Math.round(mins)} min since assigned` };
      }
    }

    if (!issue) continue;

    // Dedup: skip if we've already alerted on this booking.
    try {
      const { data: prior } = await sb
        .from('activity_logs')
        .select('id')
        .eq('booking_id', b.id)
        .eq('event_type', 'ops_alert_sent')
        .gte('created_at', sixHoursAgo)
        .limit(1);
      if (prior && prior.length) continue;
    } catch (e) { /* if dedup check fails, fall through (better a dup than a miss) */ }

    issues.push({ b, ...issue });
  }

  if (!issues.length) {
    await logCron('ops-alert', { status: 'ok', records: 0, duration: Date.now() - t });
    return res.status(200).json({ alerted: 0 });
  }

  // Sort by severity for the digest
  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  issues.sort((x, y) => order[x.sev] - order[y.sev]);

  const sevColor = { CRITICAL: '#dc2626', HIGH: '#ea580c', MEDIUM: '#b45309' };
  const rows = issues.map(({ b, sev, label }) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top">
        <span style="display:inline-block;font-size:10px;font-weight:800;letter-spacing:0.5px;color:#fff;background:${sevColor[sev]};border-radius:4px;padding:2px 6px">${sev}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0">
        <div style="font-size:14px;font-weight:700;color:#111">${esc(b.ref)} &bull; ${esc(b.service || '')}</div>
        <div style="font-size:13px;color:#52525b;margin-top:2px">${esc(label)}</div>
        <div style="font-size:12px;color:#71717a;margin-top:2px">${esc(b.customer_name || '')}${b.customer_phone ? ' &bull; <a href="tel:' + esc(b.customer_phone) + '" style="color:#00BFFF">' + esc(b.customer_phone) + '</a>' : ''}</div>
      </td>
    </tr>`).join('');

  const critCount = issues.filter(i => i.sev === 'CRITICAL').length;
  const subject = `${critCount ? 'Urgent: ' : ''}${issues.length} booking${issues.length === 1 ? '' : 's'} need your attention`;

  let alerted = 0;
  let deliveryError = null;
  try {
    const emailResult = await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase System <booking@assembleatease.com>',
      subject,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;border-top:4px solid #dc2626"><tr><td style="padding:22px 20px">
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#dc2626">Action Needed</p>
    <p style="margin:0 0 16px;font-size:19px;font-weight:700">${issues.length} booking${issues.length === 1 ? '' : 's'} need attention</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:8px;border-collapse:separate">${rows}</table>
    <a href="https://www.assembleatease.com/owner/" style="display:inline-block;margin-top:18px;background:#00BFFF;color:#fff;padding:11px 26px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">Open Live Ops</a>
    <p style="margin:14px 0 0;font-size:11px;color:#a1a1aa">Unresolved booking alerts may repeat after six hours. Routine unassigned jobs are handled by dispatch.</p>
  </td></tr></table>
</div></body></html>`,
      replyTo: ownerEmail(),
      meta: { notificationType: 'ops_alert', recipientType: 'owner', disableDedupe: true },
    });

    if (emailResult?.ok && !emailResult?.suppressed) {
      // Mark only confirmed delivery attempts so failed alerts remain retryable.
      for (const { b, sev, label } of issues) {
        await logActivity(sb, {
          bookingId: b.id,
          eventType: 'ops_alert_sent',
          actorType: 'system',
          actorName: 'ops_alert',
          description: `Owner alerted [${sev}]: ${label}`,
          metadata: { severity: sev },
        });
        alerted++;
      }
      if (emailResult.logged === false) {
        deliveryError = emailResult.logError || 'Owner alert was delivered, but its notification log failed';
      }
    } else {
      deliveryError = emailResult?.error || emailResult?.reason || 'Owner alert email was not delivered';
    }
  } catch (e) {
    console.error('ops-alert email error:', e);
    deliveryError = e?.message || String(e);
  }

  await logCron('ops-alert', { status: deliveryError ? 'warning' : 'ok', records: alerted, error: deliveryError, duration: Date.now() - t });
  return res.status(200).json({ alerted, refs: issues.map(i => i.b.ref), deliveryError });
}
