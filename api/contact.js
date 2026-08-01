import { getSupabase } from './_supabase.js';
import { upsertContact, addNote } from './_hubspot.js';
import { rateLimit } from './_ratelimit.js';
import { sendEmail, ownerEmail, esc } from './_email.js';
import {
  OPERATION_CASE_SOURCES,
  OPERATION_CASE_TYPES,
  appendOperationCaseEvent,
  buildOperationCaseRef,
  createOperationCase,
  isMissingOperationCasesError,
  operationCasePublicStatus,
} from './_operation-cases.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SITE = 'https://www.assembleatease.com';
const LOGO = `${SITE}/images/logo.jpg`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'default')) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }
  } catch (rateLimitError) {
    console.error('Contact rate limit unavailable:', rateLimitError?.message || rateLimitError);
  }

  const payload = normalizeContactRequest(req.body || {});
  const validationError = validateContactRequest(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  const sb = getSupabase();
  let caseRef = buildOperationCaseRef('CS');
  let operationCase;

  // Durability comes first. Do not promise that a request was received until
  // its operational record and initial audit event exist in the database.
  try {
    operationCase = await createOperationCase(sb, {
      caseRef,
      caseType: OPERATION_CASE_TYPES.SUPPORT,
      source: OPERATION_CASE_SOURCES.CONTACT_FORM,
      sourceRef: payload.requestId || caseRef,
      severity: 'normal',
      subject: payload.subject || 'General inquiry',
      description: payload.message,
      customerName: payload.name,
      customerEmail: payload.email,
      createdByType: 'customer',
      createdByName: payload.name,
      metadata: { submittedFrom: 'website_contact_form', requestId: payload.requestId || null },
    });
    // An idempotent retry may return the case created by the first attempt.
    // Always use the durable record's reference in emails and the response.
    caseRef = operationCase.case_ref;
  } catch (error) {
    console.error('Contact case creation failed:', error?.message || error);
    const setupNeeded = isMissingOperationCasesError(error);
    return res.status(503).json({
      error: setupNeeded
        ? 'Support requests are temporarily unavailable while a required update is completed. Please email service@assembleatease.com.'
        : 'We could not safely save your message. Please email service@assembleatease.com.',
      setupNeeded,
    });
  }

  const notificationResults = await Promise.allSettled([
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase Support <contact@assembleatease.com>',
      subject: `New support case ${caseRef}: ${payload.subject || 'General inquiry'}`,
      replyTo: payload.email,
      meta: {
        operationCaseId: operationCase.id,
        notificationType: 'support_case_owner',
        recipientType: 'owner',
      },
      html: buildOwnerEmail(payload, caseRef),
    }),
    sendEmail({
      to: payload.email,
      from: 'AssembleAtEase <contact@assembleatease.com>',
      subject: `We received your message - ${caseRef}`,
      replyTo: ownerEmail(),
      meta: {
        operationCaseId: operationCase.id,
        notificationType: 'support_case_confirmation',
        recipientType: 'customer',
      },
      html: buildCustomerEmail(payload, caseRef),
    }),
  ]);

  const notificationSummary = {
    owner: settledEmailResult(notificationResults[0]),
    customer: settledEmailResult(notificationResults[1]),
  };

  try {
    await appendOperationCaseEvent(sb, {
      caseId: operationCase.id,
      eventType: 'notification_attempted',
      actorType: 'system',
      actorName: 'Notification Service',
      note: 'Owner alert and customer confirmation were attempted.',
      metadata: notificationSummary,
    });
  } catch (eventError) {
    // The case is already durable and notification_log is authoritative for
    // delivery attempts. This secondary timeline entry must not lose intake.
    console.error('Contact notification case event failed:', eventError?.message || eventError);
  }

  await recordHubSpot(payload, caseRef).catch((error) => {
    console.error('HubSpot contact error:', error?.message || error);
  });

  const publicStatus = operationCasePublicStatus(operationCase.status, 'customer');
  return res.status(200).json({
    success: true,
    ref: caseRef,
    status: publicStatus.code,
    statusLabel: publicStatus.label,
    message: 'Your message was saved. We will follow up using the contact information you provided.',
  });
}

export function normalizeContactRequest(body = {}) {
  return {
    name: clean(body.name, 120),
    email: clean(body.email, 254).toLowerCase(),
    subject: clean(body.subject, 180),
    message: cleanMultiline(body.message, 5000),
    requestId: normalizeRequestId(body.requestId),
  };
}

export function validateContactRequest(payload) {
  if (!payload.name) return 'Name is required.';
  if (!EMAIL_RE.test(payload.email)) return 'A valid email is required.';
  if (!payload.message) return 'Message is required.';
  if (payload.message.length < 5) return 'Please provide a little more detail.';
  return null;
}

function settledEmailResult(result) {
  if (!result || result.status === 'rejected') {
    return { ok: false, error: String(result?.reason?.message || result?.reason || 'Notification failed') };
  }
  return {
    ok: result.value?.ok === true,
    providerId: result.value?.providerId || null,
    error: result.value?.error || null,
  };
}

async function recordHubSpot(payload, caseRef) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) return;
  const contactId = await upsertContact({
    email: payload.email,
    name: payload.name,
    lifecycleStage: 'lead',
  });
  if (!contactId) return;
  await addNote({
    contactId,
    body: `<strong>Support Case</strong><br>Ref: ${esc(caseRef)}<br>Subject: ${esc(payload.subject || 'General inquiry')}<br>Message: ${esc(payload.message)}`,
  });
}

function buildOwnerEmail(payload, caseRef) {
  return emailShell(`
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b">Support case ${esc(caseRef)}</p>
    <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25;color:#111827">${esc(payload.subject || 'General inquiry')}</h1>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
      ${emailRow('Customer', payload.name)}
      ${emailRow('Email', payload.email)}
    </table>
    <div style="padding:16px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;line-height:1.7;color:#1f2937;white-space:pre-wrap">${esc(payload.message)}</div>
    <div style="margin-top:18px;padding:14px 16px;border:1px solid #bae6fd;background:#f0f9ff;border-radius:8px;color:#075985;font-size:13px;line-height:1.6">
      This request is saved in Owner Dashboard &gt; Cases. Update the case there so acknowledgment and resolution are logged.
    </div>
  `);
}

function buildCustomerEmail(payload, caseRef) {
  return emailShell(`
    <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;color:#111827">We received your message.</h1>
    <p style="margin:0 0 22px;font-size:15px;color:#4b5563;line-height:1.7">Hello ${esc(payload.name)}, your request was saved. We will follow up using the contact information you provided.</p>
    <div style="padding:18px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b">Reference</div>
      <div style="font-size:18px;font-weight:800;color:#111827;margin-top:4px">${esc(caseRef)}</div>
      <div style="font-size:13px;color:#64748b;margin-top:12px">${esc(payload.subject || 'General inquiry')}</div>
    </div>
    <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6">Keep this reference if you contact us again about the same request.</p>
  `);
}

function emailShell(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827">
  <div style="max-width:620px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;text-align:center">
        <img src="${LOGO}" alt="AssembleAtEase" width="40" height="40" style="border-radius:50%;display:inline-block"/>
        <div style="font-size:16px;font-weight:800;margin-top:7px">AssembleAtEase</div>
      </div>
      <div style="padding:28px 24px">${content}</div>
      <div style="padding:16px 24px;background:#fafafa;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af">
        AssembleAtEase &bull; Austin, Texas &bull; service@assembleatease.com
      </div>
    </div>
  </div></body></html>`;
}

function emailRow(label, value) {
  return `<tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#64748b;width:120px;vertical-align:top">${esc(label)}</td><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-weight:700">${esc(value || '-') }</td></tr>`;
}

function clean(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || '').trim().replace(/\r\n?/g, '\n').slice(0, maxLength);
}

function normalizeRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[a-z0-9-]{20,64}$/i.test(requestId) ? requestId.toLowerCase() : '';
}
