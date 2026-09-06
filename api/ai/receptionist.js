import { createHash, timingSafeEqual } from 'node:crypto';
import { getBookingCatalog } from '../_pricing.js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { hasDurableRateLimit, rateLimitKey } from '../_ratelimit.js';
import { createOperationCase, appendOperationCaseEvent, buildOperationCaseRef } from '../_operation-cases.js';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };
const SITE = 'https://www.assembleatease.com';
const INTAKE_FIELDS = new Set([
  'action', 'conversationId', 'callControlId', 'service', 'name', 'phone', 'city', 'project',
  'preferredTime', 'detailsConfirmed', 'callbackConsent',
]);

// Catalog names/items come from the same source used by server-side pricing.
// Deliberately no prices: only secure checkout calculates the customer's total.
export function receptionistCatalog(catalog = getBookingCatalog()) {
  return Object.entries(catalog.subcategories || {}).map(([service, groups]) => ({
    service,
    label: service === 'Other' ? 'Custom project / not sure' : service,
    groups: Array.from(groups, group => ({
      name: group.group,
      items: Array.from(group.items, item => ({ name: item.name, customQuote: item.customQuote === true })),
    })),
    bookingUrl: bookingUrl(service),
  }));
}

function bookingUrl(service) {
  const url = new URL('/book', SITE);
  url.searchParams.set('service', service);
  url.searchParams.set('utm_source', 'sora');
  url.searchParams.set('utm_medium', 'voice');
  return url.toString();
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean.length <= max && !/[\u0000-\u001f\u007f]/.test(clean) ? clean : '';
}

export function validateReceptionistIntake(body, catalog = getBookingCatalog()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !INTAKE_FIELDS.has(key))) return { error: 'Unexpected request fields.' };
  if (body.detailsConfirmed !== true || body.callbackConsent !== true) {
    return { error: 'The caller must confirm the request and agree to a callback before saving.' };
  }
  // Voice tools preset Telnyx's built-in call_control_id, never an LLM-chosen ID.
  // Hash its opaque identifier to fit the existing case source_ref; no new table.
  let conversationId = text(body.conversationId, 100);
  if (body.callControlId !== undefined) {
    if (body.conversationId !== undefined || typeof body.callControlId !== 'string'
        || !/^v3:[A-Za-z0-9_+/=-]{10,1000}$/.test(body.callControlId)) {
      return { error: 'A valid provider call reference is required.' };
    }
    conversationId = `call_${createHash('sha256').update(body.callControlId).digest('hex')}`;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{9,99}$/.test(conversationId)) return { error: 'A valid conversation reference is required.' };
  const service = text(body.service, 80);
  if (!Object.hasOwn(catalog.subcategories || {}, service)) return { error: 'Choose an exact service from the catalog.' };
  const name = text(body.name, 120);
  const city = text(body.city, 100);
  const project = text(body.project, 1500);
  const preferredTime = text(body.preferredTime || 'Not specified', 120);
  const rawPhone = typeof body.phone === 'string' && body.phone.length <= 30 ? body.phone : '';
  if (/[^\d+().\s-]/.test(rawPhone)) return { error: 'Use a US callback number without an extension.' };
  const digits = rawPhone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return { error: 'A valid US callback number is required.' };
  if (!name || !city || project.length < 10 || !preferredTime) return { error: 'Name, city, and a clear project summary are required.' };
  return { value: { conversationId, service, name, phone: `+1${digits}`, city, project, preferredTime } };
}

function authorized(req, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// This project's preview currently inherits the live database and email setup.
// Catalog testing must not implicitly enable live case writes. Until there is
// a verified isolated sandbox, callback persistence is production-only and
// requires its own explicit activation in addition to the intake/auth gate.
export function receptionistCallbacksEnabled(env = process.env) {
  return env.TELNYX_AI_CALLBACKS_ENABLED === 'true'
    && env.VERCEL_ENV === 'production'
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production');
}

export function createReceptionistHandler({
  env = process.env, catalog = getBookingCatalog, supabase = getSupabase,
  createCase = createOperationCase, appendEvent = appendOperationCaseEvent,
  email = options => sendEmail(options), ownerAddress = ownerEmail, newRef = buildOperationCaseRef,
  durableLimit = hasDurableRateLimit, limit = rateLimitKey,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    // Deployment alone must never enable a new live customer workflow.
    if (env.TELNYX_AI_INTAKE_ENABLED !== 'true') return res.status(503).json({ error: 'Assistant intake is not enabled.' });
    if (!authorized(req, env.TELNYX_AI_TOOL_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    let source;
    try { source = catalog(); } catch { return res.status(503).json({ error: 'Service information is temporarily unavailable.' }); }
    if (req.body?.action === 'catalog') {
      if (Object.keys(req.body).some(key => !['action', 'service'].includes(key))) return res.status(400).json({ error: 'Unexpected catalog fields.' });
      const selected = req.body.service;
      if (selected !== undefined && (typeof selected !== 'string' || !Object.hasOwn(source.subcategories || {}, selected))) {
        return res.status(400).json({ error: 'Choose an exact service from the catalog.' });
      }
      const services = receptionistCatalog(source);
      return res.status(200).json({
        // Keep the initial voice-tool response short. Load item detail only
        // for the selected category, not 201 items on every customer turn.
        services: selected ? services.filter(service => service.service === selected)
          : services.map(({ service, label, groups, bookingUrl: url }) => ({ service, label, groups: groups.map(group => group.name), bookingUrl: url })),
        bookingCreated: false,
        callbackRequestsEnabled: receptionistCallbacksEnabled(env),
        message: 'Use these exact service names. Availability and final totals are confirmed only through secure booking.',
      });
    }
    if (req.body?.action !== 'request_callback') return res.status(400).json({ error: 'Unsupported action.' });
    if (!receptionistCallbacksEnabled(env)) {
      return res.status(503).json({ error: 'Callback requests are unavailable here. Please use the contact page.', bookingCreated: false });
    }
    const validation = validateReceptionistIntake(req.body, source);
    if (validation.error) return res.status(400).json({ error: validation.error });
    try {
      if (!durableLimit()) return res.status(503).json({ error: 'Callback requests are temporarily unavailable. Please use the contact page.' });
      if (!await limit('telnyx-ai:intake', 'default')) return res.status(429).json({ error: 'Please use the contact page or try again shortly.' });
    } catch {
      return res.status(503).json({ error: 'Callback requests are temporarily unavailable. Please use the contact page.' });
    }
    const input = validation.value;
    const testLabel = input.name === 'TEST - Sora integration' && input.project.startsWith('TEST ONLY') ? '[TEST] ' : '';
    const sourceRef = `telnyx-ai:${input.conversationId}`;
    const description = [
      'AI-assisted callback request. Caller-provided details; not an identity-verified booking.',
      `Service: ${input.service}`, `City: ${input.city}`,
      `Project: ${input.project}`, `Requested time (not confirmed): ${input.preferredTime}`,
      'Caller confirmed these details and agreed to a callback. No SMS/marketing consent inferred.',
      'No appointment was booked, no payment was taken, and no existing booking was changed.',
    ].join('\n');
    const proposedRef = newRef('AI');
    let sb, saved;
    try {
      sb = supabase();
      // Existing RPC atomically creates the case AND its first timeline event.
      // Existing (source, source_ref) uniqueness prevents duplicate cases.
      saved = await createCase(sb, {
        caseRef: proposedRef, caseType: 'support', source: 'system', sourceRef,
        severity: 'normal', subject: `${testLabel}Sora callback: ${input.service} - ${input.city}`,
        description, customerName: input.name, customerPhone: input.phone,
        createdByType: 'system', createdByName: 'Sora (AI intake)',
        metadata: { channel: 'telnyx_ai', conversationId: input.conversationId, service: input.service,
          callbackConsent: true, detailsConfirmed: true, bookingCreated: false },
      });
      if (!saved?.id || !saved.case_ref) throw new Error('Missing saved case');
    } catch {
      return res.status(503).json({ error: 'Your request could not be saved. Please use the contact page.', bookingCreated: false });
    }
    // Never silently overwrite a caller's first confirmed request on replay.
    if (saved.description !== description || saved.customer_phone !== input.phone || saved.customer_name !== input.name) {
      return res.status(409).json({ error: 'This conversation already has a different saved request. Contact support to correct it.', bookingCreated: false });
    }
    const createdHere = saved.case_ref === proposedRef;
    if (createdHere) {
      let notice;
      try {
        notice = await email({
          to: ownerAddress(), from: 'AssembleAtEase <contact@assembleatease.com>',
          subject: `${testLabel}Sora callback request ${saved.case_ref}`,
          html: `<h2>Customer callback requested</h2><p>Reference: ${esc(saved.case_ref)}</p><p>${esc(input.name)} | ${esc(input.phone)}</p><p style="white-space:pre-wrap">${esc(description)}</p><p>Open Owner Dashboard &gt; Cases to acknowledge and follow up. This is a request, not a booking.</p>`,
          meta: { operationCaseId: saved.id, notificationType: 'ai_callback_owner', recipientType: 'owner' },
        });
      } catch { notice = { ok: false }; }
      try {
        await appendEvent(sb, {
          caseId: saved.id, eventType: 'notification_attempted', actorType: 'system', actorName: 'Notifications',
          note: notice?.providerAccepted === true
            ? 'Owner callback alert accepted by the email provider; delivery is not yet confirmed.'
            : 'Owner callback alert was not confirmed as accepted. Follow up from this open case.',
          metadata: { channel: 'email', providerAccepted: notice?.providerAccepted === true,
            deliveryConfirmed: false, logged: notice?.logged === true, suppressed: notice?.suppressed === true },
        });
      } catch {
        // The open case is already durable. Do not erase it or claim email delivery.
        console.warn('Sora callback notification timeline needs review:', createHash('sha256').update(saved.id).digest('hex').slice(0, 12));
      }
    }
    return res.status(200).json({
      success: true, ref: saved.case_ref, status: 'received', bookingCreated: false,
      bookingUrl: bookingUrl(input.service),
      message: 'Your callback request was saved. No appointment has been booked. You can also complete a booking through the secure website.',
    });
  };
}

export default createReceptionistHandler();
