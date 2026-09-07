import { createHash } from 'node:crypto';
import { cleanIntakeText as text, intakeCallReference, intakeCallbackPhone } from '../_ai-intake-validation.js';

// This is unverified support intake, NOT an Easer-account authorization path.
const TOPICS = Object.freeze({
  application: { label: 'Application help', caseType: 'account', severity: 'normal' },
  account: { label: 'Account help', caseType: 'account', severity: 'normal' },
  assigned_job: { label: 'Current job help', caseType: 'support', severity: 'high' },
  access_or_parts: { label: 'Access or missing parts', caseType: 'support', severity: 'high' },
  safety: { label: 'Work safety concern', caseType: 'safety', severity: 'high' },
  earnings: { label: 'Earnings or payout question', caseType: 'payment', severity: 'normal' },
});
const FIELDS = new Set(['action', 'conversationId', 'callControlId', 'name', 'phone', 'city',
  'topic', 'issue', 'preferredTime', 'detailsConfirmed', 'callbackConsent']);

function hasSensitiveDigits(value) {
  // Defense in depth for accidental card/SSN entry. Not a PCI redaction system:
  // the assistant must never collect these values in the first place.
  return /\b\d{3}-\d{2}-\d{4}\b/.test(value)
    || /(?:^|\D)(?:\d[ -]?){12,18}\d(?:$|\D)/.test(value);
}

export function proSupportEnabled(env = process.env) {
  return env.TELNYX_AI_PRO_SUPPORT_ENABLED === 'true'
    && env.TELNYX_AI_CALLBACKS_ENABLED === 'true'
    && env.VERCEL_ENV === 'production'
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production');
}

export function proSupportOptions(env) {
  return {
    proSupportRequestsEnabled: proSupportEnabled(env),
    topics: Object.entries(TOPICS).map(([topic, value]) => ({ topic, label: value.label })),
    accountAccessEnabled: false,
    message: 'Support requests only. No account access, application approval, job changes or payments. For immediate danger, contact emergency services directly.',
  };
}

export function validateProSupportIntake(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !FIELDS.has(key))) return { error: 'Unexpected support request fields.' };
  if (body.detailsConfirmed !== true || body.callbackConsent !== true) {
    return { error: 'Confirm the request details and callback permission before saving.' };
  }
  const conversationId = intakeCallReference(body);
  if (!conversationId) return { error: 'A valid provider conversation reference is required.' };
  const phone = intakeCallbackPhone(body.phone);
  if (!phone) return { error: 'A valid US callback number without an extension is required.' };
  const name = text(body.name, 120);
  const city = text(body.city, 100);
  const topic = text(body.topic, 40);
  const issue = text(body.issue, 1500);
  const preferredTime = text(body.preferredTime || 'Not specified', 120);
  if (!Object.hasOwn(TOPICS, topic)) return { error: 'Choose a support topic from the available options.' };
  if (!name || !city || issue.length < 10 || !preferredTime) {
    return { error: 'Name, city, and a clear issue summary are required.' };
  }
  if ([name, city, issue, preferredTime].some(hasSensitiveDigits)) {
    return { error: 'Remove card numbers, identity numbers and other sensitive data from the support details.' };
  }
  return { value: { conversationId, name, phone, city, topic, issue, preferredTime } };
}

// Called only AFTER the parent handler's feature gate and constant-time auth.
// All dependencies are injected so tests cannot reach live services.
export function createProSupportIntake({ env, supabase, createCase, appendEvent,
  email, ownerAddress, newRef, durableLimit, limit, esc }) {
  return async (body, res) => {
    if (body.action === 'support_options') {
      if (Object.keys(body).some(key => key !== 'action')) return res.status(400).json({ error: 'Unexpected support options fields.' });
      return res.status(200).json(proSupportOptions(env));
    }
    if (!proSupportEnabled(env)) return res.status(503).json({ error: 'Service Pro support intake is not enabled. Please use the contact page.', accountChanged: false });
    const validation = validateProSupportIntake(body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    try {
      if (!durableLimit()) return res.status(503).json({ error: 'Support intake is temporarily unavailable. Please use the contact page.' });
      // Share the existing assistant-wide bucket, not a second bypassable quota.
      if (!await limit('telnyx-ai:intake', 'default')) return res.status(429).json({ error: 'Please use the contact page or try again shortly.' });
    } catch {
      return res.status(503).json({ error: 'Support intake is temporarily unavailable. Please use the contact page.' });
    }
    const input = validation.value;
    const topic = TOPICS[input.topic];
    const testLabel = input.name === 'TEST - Sora Pro integration' && input.issue.startsWith('TEST ONLY') ? '[TEST] ' : '';
    const description = [
      'Service Pro support request. Caller-provided details; identity and account ownership NOT verified.',
      `Caller: ${input.name}`, `Callback number: ${input.phone}`, `City: ${input.city}`,
      `Topic: ${topic.label}`, `Issue: ${input.issue}`, `Preferred callback time (not promised): ${input.preferredTime}`,
      'Caller confirmed these details and agreed to a callback. No SMS/marketing permission inferred.',
      'No profile or booking was looked up, linked or changed. No application was submitted/approved. No payment or payout was changed.',
      'Confirm the caller identity and relevant assignment through the normal secure workflow before disclosing or changing any account or job.',
    ].join('\n');
    const proposedRef = newRef('AI');
    let sb, saved;
    try {
      sb = supabase();
      saved = await createCase(sb, {
        caseRef: proposedRef, caseType: topic.caseType, source: 'system',
        sourceRef: `telnyx-ai-pro:${input.conversationId}`, severity: topic.severity,
        subject: `${testLabel}Sora Service Pro: ${topic.label} - ${input.city}`, description,
        // Do not mislabel the caller as a customer or attach an unverified profile.
        customerName: null, customerPhone: null, customerEmail: null, easerId: null, bookingId: null,
        createdByType: 'system', createdByName: 'Sora (unverified Pro intake)',
        metadata: { channel: 'telnyx_ai', callerRole: 'service_pro', identityVerified: false,
          conversationId: input.conversationId, topic: input.topic, detailsConfirmed: true,
          callbackConsent: true, accountChanged: false, bookingCreated: false },
      });
      if (!saved?.id || !saved.case_ref) throw new Error('Missing saved case');
    } catch {
      return res.status(503).json({ error: 'Your support request could not be saved. Please use the contact page.', accountChanged: false });
    }
    if (saved.description !== description) {
      return res.status(409).json({ error: 'This conversation already has a different support request. Contact support to correct it.', accountChanged: false });
    }
    if (saved.case_ref === proposedRef) {
      let notice;
      try {
        notice = await email({
          to: ownerAddress(), from: 'AssembleAtEase <contact@assembleatease.com>',
          subject: `${testLabel}Sora Service Pro support ${saved.case_ref}`,
          html: `<h2>Service Pro support requested</h2><p>Reference: ${esc(saved.case_ref)}</p><p style="white-space:pre-wrap">${esc(description)}</p><p>Open Owner Dashboard &gt; Cases to acknowledge and follow up. This is unverified intake, not authorization to change a job or account.</p>`,
          meta: { operationCaseId: saved.id, notificationType: 'ai_pro_support_owner', recipientType: 'owner' },
        });
      } catch { notice = { ok: false }; }
      try {
        await appendEvent(sb, {
          caseId: saved.id, eventType: 'notification_attempted', actorType: 'system', actorName: 'Notifications',
          note: notice?.providerAccepted === true
            ? 'Owner Service Pro alert accepted by the email provider; delivery is not yet confirmed.'
            : 'Owner Service Pro alert was not confirmed as accepted. Follow up from this open case.',
          metadata: { channel: 'email', providerAccepted: notice?.providerAccepted === true,
            deliveryConfirmed: false, logged: notice?.logged === true, suppressed: notice?.suppressed === true },
        });
      } catch {
        console.warn('Sora Pro notification timeline needs review:', createHash('sha256').update(saved.id).digest('hex').slice(0, 12));
      }
    }
    return res.status(200).json({ success: true, ref: saved.case_ref, status: 'received',
      identityVerified: false, accountChanged: false, bookingCreated: false,
      message: 'Your support request is saved. No application, job, payment or payout was changed. A callback time has not been confirmed.' });
  };
}
