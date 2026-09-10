import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logCron } from './_cron-logger.js';
import { findStrandedBookings, STRANDED_AFTER_MINUTES } from '../_stranded-bookings-core.js';

/**
 * GET /api/cron/stranded-booking-alert — every 30 minutes.
 *
 * Tells the owner about real bookings nobody is working on. The detection rule
 * lives in _stranded-bookings-core.js with the incident that caused it.
 *
 * Deliberately separate from unassigned-escalation: that cron chases CONFIRMED
 * bookings toward an Easer and messages the customer. This one covers the
 * bookings that never reached confirmed, which no cron watched at all. Keeping
 * them apart is what stops either from quietly inheriting the other's blind
 * spot.
 *
 * It never writes to a booking. It reports, and the owner decides.
 */
const RESURFACE_HOURS = 24;

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${(n / 100).toFixed(2)}` : '$?';
}

function row(b) {
  const age = b.minutesStranded >= 120
    ? `${Math.floor(b.minutesStranded / 60)}h`
    : `${b.minutesStranded}m`;
  return `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb"><strong>${esc(b.ref || '')}</strong></td>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${esc(b.service || '')}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${esc(money(b.total_price))}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${esc(age)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${esc(b.customer_name || b.customer_email || '')}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#7f1d1d">${esc(b.strandedReason)}</td>
  </tr>`;
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const auth = String(req.headers?.authorization || '');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  let stranded = [];
  try {
    stranded = await findStrandedBookings(sb, { minutes: STRANDED_AFTER_MINUTES });
  } catch (err) {
    await logCron('stranded-booking-alert', {
      status: 'error', records: 0, errorText: err?.message || String(err), duration: Date.now() - startedAt,
    });
    return res.status(500).json({ error: 'Stranded booking scan failed' });
  }

  if (!stranded.length) {
    await logCron('stranded-booking-alert', { status: 'ok', records: 0, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: true, stranded: 0 });
  }

  // Resurface rather than nag: a booking already reported stays quiet for a day
  // unless it is still stranded tomorrow, in which case it is worth saying again.
  const since = new Date(Date.now() - RESURFACE_HOURS * 3600 * 1000).toISOString();
  const { data: recent } = await sb
    .from('operational_events')
    .select('payload, created_at')
    .eq('event_type', 'stranded_booking_alert')
    .gte('created_at', since);
  const alreadyReported = new Set();
  for (const e of recent || []) {
    for (const ref of e?.payload?.refs || []) alreadyReported.add(ref);
  }

  const fresh = stranded.filter(b => !alreadyReported.has(b.ref));
  if (!fresh.length) {
    await logCron('stranded-booking-alert', { status: 'ok', records: 0, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: true, stranded: stranded.length, alerted: 0, reason: 'already reported' });
  }

  const total = fresh.reduce((sum, b) => sum + (Number(b.total_price) || 0), 0);
  const emailResult = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase System <booking@assembleatease.com>',
    subject: `${fresh.length} booking${fresh.length === 1 ? '' : 's'} nobody is working on — ${money(total)}`,
    html: `<p><strong>${fresh.length} paid-intent booking${fresh.length === 1 ? ' has' : 's have'} been sitting unassigned`
      + ` for more than ${STRANDED_AFTER_MINUTES} minutes.</strong> No Easer has been offered ${fresh.length === 1 ? 'it' : 'them'}.</p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <tr style="background:#f8fafc">
          <th style="padding:8px 10px;text-align:left">Ref</th>
          <th style="padding:8px 10px;text-align:left">Service</th>
          <th style="padding:8px 10px;text-align:left">Total</th>
          <th style="padding:8px 10px;text-align:left">Waiting</th>
          <th style="padding:8px 10px;text-align:left">Customer</th>
          <th style="padding:8px 10px;text-align:left">Why</th>
        </tr>
        ${fresh.map(row).join('')}
      </table>
      <p style="margin-top:16px">Open the booking in the dashboard to assign an Easer by hand, or contact the customer.
      Nothing has been changed automatically.</p>
      <p style="font-size:12px;color:#64748b">On 2026-08-18 three bookings worth $987 sat exactly like this for four days
      and were never shown to anyone, because no cron watched bookings that had not reached confirmed. This alert exists
      so that cannot repeat quietly.</p>`,
    replyTo: ownerEmail(),
    meta: { notificationType: 'stranded_booking_alert', recipientType: 'owner', disableDedupe: true },
  }).catch(err => ({ ok: false, error: err?.message || String(err) }));

  // Recorded AFTER the send, so a failed email is not remembered as reported and
  // the next run tries again rather than going silent.
  if (emailResult?.ok !== false) {
    try {
      await sb.from('operational_events').insert({
        event_type: 'stranded_booking_alert',
        route: '/api/cron/stranded-booking-alert',
        method: 'CRON',
        actor_role: 'cron',
        stage: 'alert',
        reason_code: 'bookings_unassigned_beyond_threshold',
        reason_detail: String(fresh.length),
        mutation_result: 'owner_alerted',
        payload: { refs: fresh.map(b => b.ref), totalCents: total, minutes: STRANDED_AFTER_MINUTES },
      });
    } catch { /* logging is never worth failing the request for */ }
  }

  await logCron('stranded-booking-alert', {
    status: emailResult?.ok === false ? 'error' : 'ok',
    records: fresh.length,
    errorText: emailResult?.ok === false ? String(emailResult.error).slice(0, 300) : null,
    duration: Date.now() - startedAt,
  });

  return res.status(200).json({ ok: true, stranded: stranded.length, alerted: fresh.length });
}
