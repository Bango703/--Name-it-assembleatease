import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc, formatAddress } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { notificationAppointmentTimestampMs, formatAppointmentDate, formatAppointmentDateShort } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';

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

function currentUnaccepted(query, booking) {
  return query.eq('id', booking.id).eq('status', BOOKING_STATUS.CONFIRMED)
    .eq('date', booking.date).eq('time', booking.time).is('assembler_accepted_at', null)
    .or('return_visit_required.is.null,return_visit_required.eq.false');
}

// Old versions claimed these stamps BEFORE sending. Only a successful provider
// record can make an old stamp credible; queued/suppressed/failed are not proof.
async function verifiedNoticeAt(sb, booking, type, recipientType, stamp) {
  if (!stamp || (booking.rescheduled_at && stamp < booking.rescheduled_at)) return null;
  const { data, error } = await sb.from('notification_log').select('sent_at')
    .eq('booking_id', booking.id).eq('channel', 'email')
    .eq('notification_type', type).eq('recipient_type', recipientType)
    .in('status', ['provider_accepted', 'sent', 'delivered', 'delivery_delayed'])
    .gte('sent_at', new Date(Math.max(Date.parse(stamp) - 60000, Date.parse(booking.rescheduled_at) || 0)).toISOString())
    .order('sent_at', { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0]?.sent_at || null;
}

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
  let failed = 0;
  let deferred = 0;

  try {
    const { data: candidates, error } = await sb
      .from('bookings')
      .select('id, ref, service, date, time, address, service_zip, service_city, customer_name, customer_email, total_price, status, assembler_id, assembler_name, assembler_accepted_at, dispatch_status, needs_manual_dispatch, unassigned_escalated_at, unassigned_customer_notified_at, rescheduled_at, return_visit_required')
      .eq('status', BOOKING_STATUS.CONFIRMED)
      // Assignment is not commitment. This booking was assigned three times and
      // accepted by nobody — acceptance is the only thing that means a pro is
      // actually coming.
      .is('assembler_accepted_at', null)
      .gte('date', new Date(now - LOOKBACK_HOURS * 3600000).toISOString().slice(0, 10));
    if (error) throw error;

    for (const b of candidates || []) {
      if (b.return_visit_required === true) continue;
      const apptMs = notificationAppointmentTimestampMs(b);
      if (!apptMs) continue;
      const hoursUntil = (apptMs - now) / 3600000;
      if (hoursUntil < -LOOKBACK_HOURS || hoursUntil > SOURCING_ESCALATION_HOURS) continue;

      const { data: current, error: currentError } = await currentUnaccepted(sb.from('bookings').select('id'), b).maybeSingle();
      if (currentError) throw currentError;
      if (!current) continue;
      const eventKey = ['unstaffed', b.id, b.date, b.time, b.rescheduled_at || 'original'].join(':');

      // ── Stage 2: the cutoff. Tell the customer. ───────────────────────────
      if (hoursUntil <= CUSTOMER_CUTOFF_HOURS) {
        let customerSentAt = await verifiedNoticeAt(sb, b, 'unassigned_customer_notice', 'customer', b.unassigned_customer_notified_at);
        const manageUrl = `https://www.assembleatease.com/track?ref=${encodeURIComponent(b.ref)}`;
        const customerResult = customerSentAt ? { ok: true, suppressed: true } : !b.customer_email ? { ok: false, reason: 'missing_customer_email' } : await sendEmail({
          to: b.customer_email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `We haven't confirmed a pro for your ${esc(formatAppointmentDateShort(b.date))} appointment — ${esc(b.ref)}`,
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h2 style="color:#00BFFF">Your appointment needs an update</h2>
            <p>Hi ${esc((b.customer_name || '').split(' ')[0] || 'there')}, we have not been able to confirm a pro for your <strong>${esc(b.service || 'appointment')}</strong> on <strong>${esc(formatAppointmentDate(b.date))}</strong>${b.time ? ' at ' + esc(b.time) : ''}.</p>
            <p>We would rather tell you now than let you wait. Two options, and <strong>neither costs you anything</strong>:</p>
            <ul style="line-height:1.9;color:#3f3f46">
              <li><strong>Pick a new time</strong> — we will prioritise finding you a pro for it.</li>
              <li><strong>Cancel</strong> — no cancellation fee. Your booking will show the cancellation and any payment update.</li>
            </ul>
            <p style="margin-top:18px"><a href="${manageUrl}" style="display:inline-block;background:#00BFFF;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">Reschedule or cancel</a></p>
            <p style="font-size:14px;color:#52525b;line-height:1.7">We are still trying to fill it. If a pro accepts before you decide, we will let you know straight away. Questions, or want us to keep trying? Call or text <a href="tel:+19792325139" style="color:#00BFFF;text-decoration:none">(979) 232-5139</a>.</p>
            <p style="font-size:13px;color:#71717a">This is our shortfall, not yours. Sorry for the disruption.</p>
          </div>`,
          replyTo: ownerEmail(),
          meta: { bookingId: b.id, notificationType: 'unassigned_customer_notice', recipientType: 'customer', notificationKey: `${eventKey}:customer`, routine: false },
        }).catch(err => ({ ok: false, error: err?.message || String(err) }));

        if (customerResult?.deferred) { deferred++; continue; }
        if (customerResult?.ok) {
          customerSentAt ||= customerResult.sentAt || new Date().toISOString();
          let update = currentUnaccepted(sb.from('bookings').update({
            unassigned_customer_notified_at: customerSentAt,
            unassigned_escalation_stage: 'customer_notified',
          }), b);
          update = b.unassigned_customer_notified_at
            ? update.eq('unassigned_customer_notified_at', b.unassigned_customer_notified_at)
            : update.is('unassigned_customer_notified_at', null);
          const { data: marked, error: markError } = await update.select('id');
          if (markError) throw markError;
          if (!customerResult.suppressed) {
            customersNotified += 1;
            await logActivity(sb, {
              bookingId: b.id, eventType: 'unassigned_customer_notified', actorType: 'system', actorName: 'escalation',
              description: `Unstaffed-job email accepted for delivery; customer offered a free reschedule or cancellation (${Math.round(hoursUntil * 60)} min before the appointment)`,
              metadata: { hoursUntil: Number(hoursUntil.toFixed(2)), dispatchStatus: b.dispatch_status, notificationKey: `${eventKey}:customer`, bookingStampUpdated: Boolean(marked?.length) },
            });
          }
        } else {
          failed++;
          // Repair a legacy false success stamp, but only while this exact
          // unaccepted appointment remains current.
          if (b.unassigned_customer_notified_at) {
            const { error: repairError } = await currentUnaccepted(sb.from('bookings').update({
              unassigned_customer_notified_at: null,
              unassigned_escalation_stage: b.unassigned_escalated_at ? 'sourcing' : null,
            }), b).eq('unassigned_customer_notified_at', b.unassigned_customer_notified_at);
            if (repairError) throw repairError;
          }
          await logActivity(sb, {
            bookingId: b.id, eventType: 'unassigned_customer_notice_failed', actorType: 'system', actorName: 'escalation',
            description: 'Customer staffing email delivery was not confirmed. Check the delivery log and contact the customer.',
            metadata: { notificationKey: `${eventKey}:customer`, error: customerResult?.error || customerResult?.reason || 'send_failed' },
          });
        }

        const customerNotified = customerResult?.ok === true;
        const ownerResult = await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `${customerNotified ? 'CUSTOMER EMAIL SENT' : 'CUSTOMER CONTACT NEEDED'} — ${b.ref} still has no pro`,
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h2 style="color:#dc2626">${customerNotified ? 'Customer staffing email accepted for delivery' : 'Staffing notice not confirmed: contact the customer'}</h2>
            <p><strong>${esc(b.ref)}</strong> — ${esc(b.service || '')} on ${esc(formatAppointmentDate(b.date))}${b.time ? ' at ' + esc(b.time) : ''} — reached ${CUSTOMER_CUTOFF_HOURS}h out with no accepted Easer.</p>
            <p>${customerNotified ? `${esc(b.customer_name || 'The customer')} was sent the free reschedule or cancellation options. Email acceptance is not confirmation that the customer read it.` : `Customer email delivery was not confirmed. Review the delivery log, then contact ${esc(b.customer_name || 'the customer')} directly and offer a free reschedule or cancellation.`} ${esc(formatAddress(b) || '')}</p>
            <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">Open the dashboard</a></p>
          </div>`,
          meta: { bookingId: b.id, notificationType: 'unassigned_customer_notice', recipientType: 'owner', notificationKey: `${eventKey}:owner:${customerNotified ? 'sent' : 'failed'}`, routine: false },
        }).catch(err => ({ ok: false, error: err?.message || String(err) }));
        if (ownerResult?.ok) {
          const { error: markError } = await currentUnaccepted(sb.from('bookings').update({
            // This is the owner's successful alert, never a pre-send claim.
            // Keep it no later than the customer stamp to satisfy legacy ordering.
            unassigned_escalated_at: b.unassigned_escalated_at || customerSentAt || new Date().toISOString(),
            unassigned_escalation_stage: customerNotified ? 'customer_notified' : 'sourcing',
          }), b);
          if (markError) throw markError;
        } else if (ownerResult?.deferred) deferred++;
        else {
          failed++;
          await logActivity(sb, { bookingId: b.id, eventType: 'unassigned_owner_notice_failed', actorType: 'system', actorName: 'escalation', description: 'Owner staffing email delivery was not confirmed. Review the delivery log.', metadata: { error: ownerResult?.error || ownerResult?.reason || 'send_failed' } });
        }
        continue;
      }

      // ── Stage 1: urgent sourcing. Owner only. ─────────────────────────────
      if (hoursUntil <= SOURCING_ESCALATION_HOURS) {
        if (await verifiedNoticeAt(sb, b, 'unassigned_sourcing_escalation', 'owner', b.unassigned_escalated_at)) continue;
        const ownerResult = await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `URGENT — ${esc(b.ref)} has no pro and is ${Math.round(hoursUntil)}h away`,
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h2 style="color:#dc2626">Source a pro now</h2>
            <p><strong>${esc(b.ref)}</strong> — ${esc(b.service || '')} on ${esc(formatAppointmentDate(b.date))}${b.time ? ' at ' + esc(b.time) : ''} — has <strong>no accepted Easer</strong> and is about ${Math.round(hoursUntil)} hour(s) away.</p>
            <p>${esc(b.assembler_name ? 'Assigned to ' + b.assembler_name + ' but not accepted.' : 'Nobody is assigned.')}</p>
            <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:0.75rem;color:#991b1b;font-size:14px">
              If this is still unaccepted at ${CUSTOMER_CUTOFF_HOURS}h out, <strong>the customer will be emailed automatically</strong> and offered a free reschedule or cancellation.
            </p>
            <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">Open the dashboard</a></p>
          </div>`,
          meta: { bookingId: b.id, notificationType: 'unassigned_sourcing_escalation', recipientType: 'owner', notificationKey: `${eventKey}:sourcing`, routine: false },
        }).catch(err => ({ ok: false, error: err?.message || String(err) }));
        if (!ownerResult?.ok) {
          if (ownerResult?.deferred) deferred++;
          else {
            failed++;
            await logActivity(sb, { bookingId: b.id, eventType: 'unassigned_owner_notice_failed', actorType: 'system', actorName: 'escalation', description: 'Urgent sourcing email delivery was not confirmed. Review the delivery log.', metadata: { error: ownerResult?.error || ownerResult?.reason || 'send_failed' } });
          }
          continue;
        }
        const { error: markError } = await currentUnaccepted(sb.from('bookings').update({
          unassigned_escalated_at: ownerResult.sentAt || new Date().toISOString(),
          unassigned_escalation_stage: 'sourcing',
        }), b);
        if (markError) throw markError;

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

    await logCron('unassigned-escalation', { status: failed ? 'error' : 'ok', records: escalated + customersNotified, errorText: failed ? `${failed} staffing notice(s) failed; retry required` : null, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: failed === 0, escalated, customersNotified, failed, deferred });
  } catch (err) {
    console.error('[unassigned-escalation] failed:', err?.message || err);
    await logCron('unassigned-escalation', { status: 'error', records: escalated + customersNotified, errorText: err?.message || String(err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Escalation run failed' });
  }
}
