import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc, formatAddress } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { appointmentTimestampMs } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/unassigned-escalation — every 15 minutes.
 *
 * WHAT THIS PREVENTS
 * A booking reached twenty-three minutes before the end of the customer's window
 * with no Easer ever having accepted it. The owner was alerted four times. The
 * customer was told nothing, waited all morning for a pro who was never coming,
 * and then cancelled it herself and was charged a fee.
 *
 * The fee is already impossible — computeCancellationFee refuses to charge when
 * no Easer accepted. This closes the other half: the customer gets TOLD, by the
 * system, before their window arrives.
 *
 * TWO STAGES, BECAUSE THEY ARE DIFFERENT PROMISES
 *   T-6h  sourcing   — the owner is told to source urgently. Still recoverable;
 *                      the customer is not alarmed over something usually fixed.
 *   T-2h  customer   — the cutoff. We have not confirmed a pro, so the customer
 *                      is told plainly and offered a free reschedule or
 *                      cancellation. Waiting past this point to "maybe" fill it
 *                      spends the customer's morning on our staffing problem.
 *
 * IT NEVER CANCELS ANYTHING. It tells the truth and hands the customer the
 * choice. Cancelling on someone's behalf because we could not staff their job
 * would compound the failure, and the customer may still want the work done.
 */

const SOURCING_ESCALATION_HOURS = 6;
const CUSTOMER_CUTOFF_HOURS = 2;
const LOOKBACK_HOURS = 12;   // past appointments beyond this are the owner's problem

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const sb = getSupabase();
  const now = Date.now();
  let escalated = 0;
  let customersNotified = 0;

  try {
    const { data: candidates, error } = await sb
      .from('bookings')
      .select('id, ref, service, date, time, address, customer_name, customer_email, total_price, status, assembler_id, assembler_name, assembler_accepted_at, dispatch_status, needs_manual_dispatch, unassigned_escalated_at, unassigned_customer_notified_at')
      .eq('status', 'confirmed')
      // Assignment is not commitment. This booking was assigned three times and
      // accepted by nobody — acceptance is the only thing that means a pro is
      // actually coming.
      .is('assembler_accepted_at', null)
      .gte('date', new Date(now - LOOKBACK_HOURS * 3600000).toISOString().slice(0, 10));
    if (error) throw error;

    for (const b of candidates || []) {
      const apptMs = appointmentTimestampMs(b.date, b.time);
      if (!apptMs) continue;
      const hoursUntil = (apptMs - now) / 3600000;
      if (hoursUntil < -LOOKBACK_HOURS) continue;

      // ── Stage 2: the cutoff. Tell the customer. ───────────────────────────
      if (hoursUntil <= CUSTOMER_CUTOFF_HOURS && !b.unassigned_customer_notified_at && b.customer_email) {
        const { data: claimed } = await sb.from('bookings')
          .update({
            unassigned_customer_notified_at: new Date().toISOString(),
            unassigned_escalation_stage: 'customer_notified',
            // Escalation is implied once we have told the customer; back-fill it
            // so the order constraint holds even if stage 1 never ran.
            unassigned_escalated_at: b.unassigned_escalated_at || new Date().toISOString(),
          })
          .eq('id', b.id)
          .is('unassigned_customer_notified_at', null)
          .is('assembler_accepted_at', null)   // an acceptance in the last second wins
          .select('id');
        if (!claimed?.length) continue;

        const manageUrl = `https://www.assembleatease.com/track?ref=${encodeURIComponent(b.ref)}`;
        await sendEmail({
          to: b.customer_email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `We haven't confirmed a pro for your ${esc(b.date)} appointment — ${esc(b.ref)}`,
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h2 style="color:#00BFFF">We need to be straight with you</h2>
            <p>Hi ${esc((b.customer_name || '').split(' ')[0] || 'there')}, we have not been able to confirm a pro for your <strong>${esc(b.service || 'appointment')}</strong> on <strong>${esc(b.date)}</strong>${b.time ? ' at ' + esc(b.time) : ''}.</p>
            <p>We would rather tell you now than let you wait. Two options, and <strong>neither costs you anything</strong>:</p>
            <ul style="line-height:1.9;color:#3f3f46">
              <li><strong>Pick a new time</strong> — we will prioritise finding you a pro for it.</li>
              <li><strong>Cancel</strong> — no cancellation fee, and your card is released in full.</li>
            </ul>
            <p style="margin-top:18px"><a href="${manageUrl}" style="display:inline-block;background:#00BFFF;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">Reschedule or cancel</a></p>
            <p style="font-size:14px;color:#52525b;line-height:1.7">We are still trying to fill it. If a pro accepts before you decide, we will let you know straight away. Questions, or want us to keep trying? Call or text <a href="tel:+17372906129" style="color:#00BFFF;text-decoration:none">737-290-6129</a>.</p>
            <p style="font-size:13px;color:#71717a">This is our shortfall, not yours. Sorry for the disruption.</p>
          </div>`,
          replyTo: ownerEmail(),
          meta: { bookingId: b.id, notificationType: 'unassigned_customer_notice', recipientType: 'customer', disableDedupe: true },
        }).catch(err => console.error('[unassigned-escalation] customer email failed:', err?.message || err));

        await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `CUSTOMER NOTIFIED — ${esc(b.ref)} still has no pro`,
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h2 style="color:#dc2626">Customer told we could not staff their job</h2>
            <p><strong>${esc(b.ref)}</strong> — ${esc(b.service || '')} on ${esc(b.date)}${b.time ? ' at ' + esc(b.time) : ''} — reached ${CUSTOMER_CUTOFF_HOURS}h out with no accepted Easer.</p>
            <p>${esc(b.customer_name || 'The customer')} has been emailed and offered a free reschedule or cancellation. ${esc(formatAddress(b) || '')}</p>
            <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">Open the dashboard</a></p>
          </div>`,
          meta: { bookingId: b.id, notificationType: 'unassigned_customer_notice', recipientType: 'owner', disableDedupe: true },
        }).catch(() => {});

        customersNotified += 1;
        await logActivity(sb, {
          bookingId: b.id,
          eventType: 'unassigned_customer_notified',
          actorType: 'system',
          actorName: 'escalation',
          description: `Customer told no pro is confirmed and offered a free reschedule or cancellation (${Math.round(hoursUntil * 60)} min before the appointment)`,
          metadata: { hoursUntil: Number(hoursUntil.toFixed(2)), dispatchStatus: b.dispatch_status },
        }).catch(() => {});
        continue;
      }

      // ── Stage 1: urgent sourcing. Owner only. ─────────────────────────────
      if (hoursUntil <= SOURCING_ESCALATION_HOURS && !b.unassigned_escalated_at) {
        const { data: claimed } = await sb.from('bookings')
          .update({
            unassigned_escalated_at: new Date().toISOString(),
            unassigned_escalation_stage: 'sourcing',
          })
          .eq('id', b.id)
          .is('unassigned_escalated_at', null)
          .is('assembler_accepted_at', null)
          .select('id');
        if (!claimed?.length) continue;

        await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `URGENT — ${esc(b.ref)} has no pro and is ${Math.round(hoursUntil)}h away`,
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h2 style="color:#dc2626">Source a pro now</h2>
            <p><strong>${esc(b.ref)}</strong> — ${esc(b.service || '')} on ${esc(b.date)}${b.time ? ' at ' + esc(b.time) : ''} — has <strong>no accepted Easer</strong> and is about ${Math.round(hoursUntil)} hour(s) away.</p>
            <p>${esc(b.assembler_name ? 'Assigned to ' + b.assembler_name + ' but not accepted.' : 'Nobody is assigned.')}</p>
            <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:0.75rem;color:#991b1b;font-size:14px">
              If this is still unaccepted at ${CUSTOMER_CUTOFF_HOURS}h out, <strong>the customer will be emailed automatically</strong> and offered a free reschedule or cancellation.
            </p>
            <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">Open the dashboard</a></p>
          </div>`,
          meta: { bookingId: b.id, notificationType: 'unassigned_sourcing_escalation', recipientType: 'owner', disableDedupe: true },
        }).catch(() => {});

        escalated += 1;
        await logActivity(sb, {
          bookingId: b.id,
          eventType: 'unassigned_sourcing_escalated',
          actorType: 'system',
          actorName: 'escalation',
          description: `No accepted Easer with ${Math.round(hoursUntil)}h to go — owner escalated to source urgently`,
          metadata: { hoursUntil: Number(hoursUntil.toFixed(2)) },
        }).catch(() => {});
      }
    }

    await logCron('unassigned-escalation', { status: 'ok', records: escalated + customersNotified, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: true, escalated, customersNotified });
  } catch (err) {
    console.error('[unassigned-escalation] failed:', err?.message || err);
    await logCron('unassigned-escalation', { status: 'error', records: escalated + customersNotified, errorText: err?.message || String(err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Escalation run failed' });
  }
}
