// ─── Solicitation alert ──────────────────────────────────────────────────────
//
// Owner, 2026-10-22: "Absolutely no exception for people joining AssembleAtEase
// to take customers." The relay guard (_relay-contact-guard.js) already refused
// an Easer message carrying a phone number, email or payment app, but the
// refusal was silent: the pro could try again with another spelling and the
// owner never heard about it.
//
// Every refused attempt now lands with the owner: one critical operations case
// per Easer per booking (later attempts are added to it), the exact text, and
// an email on the first attempt. Nothing here may stop the refusal itself, so
// every step is caught and logged.

import { sendEmail, ownerEmail, esc } from '../_email.js';
import { recordOperationalEvents } from '../_observability.js';
import {
  OPERATION_CASE_SEVERITIES,
  OPERATION_CASE_SOURCES,
  OPERATION_CASE_TYPES,
  appendOperationCaseEvent,
  createOperationCase,
} from '../_operation-cases.js';

export const SOLICITATION_EVENT = 'easer_contact_share_blocked';
const SITE = 'https://www.assembleatease.com';

export function solicitationSourceRef(easerId, bookingId) {
  return `relay-contact:${easerId}:${bookingId}`;
}

export async function recordBlockedRelayAttempt(sb, { booking, easerId, messageText, inspection, deps = {} }) {
  const create = deps.createOperationCase || createOperationCase;
  const append = deps.appendOperationCaseEvent || appendOperationCaseEvent;
  const send = deps.sendEmail || ((message) => sendEmail(message));
  const record = deps.recordOperationalEvents || recordOperationalEvents;
  const text = String(messageText || '').slice(0, 2000);
  const result = { caseRef: null, created: false, emailed: false };

  await record(sb, [{
    event_type: SOLICITATION_EVENT,
    route: '/api/booking/message',
    method: 'POST',
    actor_role: 'easer',
    stage: 'relay_guard',
    reason_code: inspection?.code || 'contact_share',
    reason_detail: inspection?.label || 'contact details',
    mutation_result: 'blocked',
    payload: { easer_id: easerId, booking_id: booking.id, booking_ref: booking.ref },
  }]).catch(() => {});

  let easerName = 'An Easer';
  try {
    const { data } = await sb.from('profiles').select('full_name, email, phone').eq('id', easerId).maybeSingle();
    if (data?.full_name) easerName = data.full_name;
    result.easer = data || null;
  } catch { /* the alert still goes out without a name */ }

  const sourceRef = solicitationSourceRef(easerId, booking.id);
  try {
    const { data: open } = await sb.from('operations_cases')
      .select('id, case_ref')
      .eq('source_ref', sourceRef)
      .not('status', 'in', '(resolved,closed)')
      .limit(1);
    const existing = Array.isArray(open) ? open[0] : null;
    if (existing) {
      await append(sb, {
        caseId: existing.id,
        eventType: 'internal_note',
        actorType: 'system',
        note: `Another blocked attempt (${inspection?.label || 'contact details'}): "${text}"`,
        metadata: { code: inspection?.code || null, text },
      });
      result.caseRef = existing.case_ref;
      return result;
    }
    const row = await create(sb, {
      caseType: OPERATION_CASE_TYPES.ACCOUNT,
      source: OPERATION_CASE_SOURCES.SYSTEM,
      sourceRef,
      severity: OPERATION_CASE_SEVERITIES.CRITICAL,
      subject: `${easerName} tried to send a customer ${inspection?.label || 'contact details'}`,
      description: `Blocked message on ${booking.ref}: "${text}"\n\nContractor agreement Section 11 forbids soliciting customers met through AssembleAtEase.`,
      bookingId: booking.id,
      customerName: booking.customer_name || null,
      easerId,
      metadata: { code: inspection?.code || null, text, guard: 'relay_contact' },
    });
    result.caseRef = row.case_ref;
    result.created = true;
  } catch (error) {
    console.error('[solicitation-alert] case not recorded:', error?.message || error);
  }

  // One email per case: the first attempt. Later attempts are on the case.
  try {
    const mail = await send({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer contact blocked: ${easerName} on ${booking.ref}`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:2rem">
        <h2 style="margin:0 0 0.5rem;color:#b91c1c">An Easer tried to send a customer ${esc(inspection?.label || 'contact details')}</h2>
        <p style="color:#3f3f46;line-height:1.6">The message was not delivered.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin:1rem 0">
          <tr><td style="padding:6px 0;color:#71717a;width:120px">Easer</td><td style="padding:6px 0"><strong>${esc(easerName)}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#71717a">Booking</td><td style="padding:6px 0">${esc(booking.ref)}</td></tr>
          <tr><td style="padding:6px 0;color:#71717a">Customer</td><td style="padding:6px 0">${esc(booking.customer_name || '')}</td></tr>
          ${result.caseRef ? `<tr><td style="padding:6px 0;color:#71717a">Case</td><td style="padding:6px 0">${esc(result.caseRef)}</td></tr>` : ''}
        </table>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;font-size:14px;color:#7f1d1d;white-space:pre-wrap">${esc(text)}</div>
        <p style="color:#3f3f46;line-height:1.6;margin-top:1rem">Section 11 of the contractor agreement forbids soliciting customers met through AssembleAtEase. Suspend or deactivate the Easer, or reassign the job, from the dashboard.</p>
        <p><a href="${SITE}/owner/" style="color:#00BFFF">Open the dashboard</a></p>
      </div>`,
      meta: { bookingId: booking.id, notificationType: 'easer_solicitation_blocked', recipientType: 'owner' },
    });
    result.emailed = mail?.ok !== false;
  } catch (error) {
    console.error('[solicitation-alert] owner email failed:', error?.message || error);
  }
  return result;
}
