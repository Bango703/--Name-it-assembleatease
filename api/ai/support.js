import { createHash, timingSafeEqual } from 'node:crypto';
import { getBookingCatalog } from '../_pricing.js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { hasDurableRateLimit, rateLimitKey } from '../_ratelimit.js';
import { createOperationCase, appendOperationCaseEvent, buildOperationCaseRef } from '../_operation-cases.js';
import { cleanIntakeText, intakeCallReference, intakeCallbackPhone } from '../_ai-intake-validation.js';

// Intake only. This module has no booking, Stripe, dispatch, or profile mutation dependency.
export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };
export const SUPPORT_TOPICS = Object.freeze({
  customer: Object.freeze({
    new_service: ['New service request', 'support', 'normal'],
    custom_quote: ['Custom quote enquiry', 'support', 'normal'],
    existing_booking: ['Existing booking question', 'support', 'normal'],
    scheduling: ['Scheduling or arrival help', 'support', 'normal'],
    cancellation: ['Cancellation request', 'support', 'normal'],
    payment: ['Charge, receipt or refund question', 'payment', 'normal'],
    quality: ['Workmanship or incomplete work', 'quality', 'high'],
    damage: ['Property damage concern', 'damage', 'high'],
    safety: ['Safety concern', 'safety', 'critical'],
  }),
  service_pro: Object.freeze({
    application: ['Application or onboarding help', 'account', 'normal'],
    account: ['Account or sign-in help', 'account', 'normal'],
    assigned_job: ['Assigned job or job-status help', 'support', 'normal'],
    access_or_parts: ['Access, missing parts or site readiness', 'support', 'normal'],
    scope_change: ['Scope change or extra work request', 'support', 'normal'],
    availability: ['Availability or scheduling issue', 'support', 'normal'],
    customer_issue: ['Customer concern or dispute', 'support', 'high'],
    safety: ['Safety concern', 'safety', 'critical'],
    earnings: ['Earnings, payout or payment question', 'payment', 'normal'],
  }),
});
const FIELDS = new Set(['action', 'callControlId', 'callerRole', 'topic', 'name', 'phone', 'email',
  'city', 'summary', 'preferredCallbackTime', 'jobReference', 'activeJob', 'requestedOutcome',
  'bookingDetails', 'detailsConfirmed', 'callbackConsent']);
const BOOKING_FIELDS = new Set(['services', 'items', 'address', 'postalCode', 'requestedDate',
  'requestedWindow', 'siteNotes', 'productNotes', 'readiness']);
const ITEM_FIELDS = new Set(['service', 'description', 'quantity']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExtra = (value, fields) => Object.keys(value).some(key => !fields.has(key));
const isNewService = value => value.callerRole === 'customer' && ['new_service', 'custom_quote'].includes(value.topic);

function text(value, max, field, required = false) {
  // Optional webhook fields may arrive as null instead of being omitted.
  // Required fields still fail here; never coerce objects or numbers to text.
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is required.`);
    return '';
  }
  const result = cleanIntakeText(value, max);
  if (!result) throw new Error(`${field} must be plain text, no more than ${max} characters.`);
  // Reject likely accidental sensitive input BEFORE Cases/email. This is not a
  // complete redactor: prevention in the voice instructions remains essential.
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(result)
      || /(?:^|\D)(?:\d[ -]?){12,18}\d(?:$|\D)/.test(result)
      || /\b(?:gate|door|alarm|lockbox|access)\s*(?:code|pin)\s*(?:is|:|=)?\s*\d{3,12}\b/i.test(result)
      || /\b(?:cvv|cvc|security code|one[- ]time code|routing number|bank account)\s*(?:is|:|=)?\s*\d{3,12}\b/i.test(result)) {
    throw new Error(`${field} may contain sensitive numbers. Omit those numbers and describe the request instead.`);
  }
  return result;
}

export function supportIntakeEnabled(env = process.env) {
  return env.TELNYX_AI_SUPPORT_ENABLED === 'true' && env.TELNYX_AI_CALLBACKS_ENABLED === 'true'
    && env.VERCEL_ENV === 'production'
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production');
}

export function supportHours(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const closes = parts.weekday === 'Sat' ? 13 * 60 : 17 * 60;
  return { timeZone: 'America/Chicago', humanSupportOpen: parts.weekday !== 'Sun' && minutes >= 7 * 60 && minutes < closes,
    humanSupportHours: 'Monday-Friday 7 AM-5 PM; Saturday 7 AM-1 PM; closed Sunday.',
    message: 'Support hours do not confirm appointment availability or guarantee that someone can answer.' };
}

export function validateSupportRequest(body, catalog) {
  try {
    if (!isObject(body) || hasExtra(body, FIELDS) || body.action !== 'submit_request') throw new Error('Unexpected support request fields or action.');
    if (body.detailsConfirmed !== true || body.callbackConsent !== true) throw new Error('Read back the details and obtain callback permission before saving.');
    // The shared tool MUST preset this from Telnyx context, never from the model.
    if (typeof body.callControlId !== 'string') throw new Error('A provider call reference is required.');
    const callRef = intakeCallReference({ callControlId: body.callControlId });
    if (!callRef) throw new Error('A valid provider call reference is required.');
    const callerRole = text(body.callerRole, 20, 'Caller role', true);
    const topic = text(body.topic, 40, 'Topic', true);
    if (!Object.hasOwn(SUPPORT_TOPICS, callerRole) || !Object.hasOwn(SUPPORT_TOPICS[callerRole], topic)) throw new Error('Choose a topic appropriate to the caller role.');
    const phone = intakeCallbackPhone(body.phone);
    if (!phone) throw new Error('A valid US callback number without an extension is required.');
    const input = { callRef, callerRole, topic, phone,
      name: text(body.name, 120, 'Name', true), email: text(body.email, 254, 'Email').toLowerCase(),
      city: text(body.city, 100, 'City'), summary: text(body.summary, 1200, 'Summary', true),
      preferredCallbackTime: text(body.preferredCallbackTime, 120, 'Preferred callback time'),
      jobReference: text(body.jobReference, 80, 'Job reference'),
      requestedOutcome: text(body.requestedOutcome, 200, 'Requested outcome'),
      activeJob: body.activeJob === true,
    };
    if (input.summary.length < 10) throw new Error('Provide a clear request summary of at least 10 characters.');
    if (input.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.email)) throw new Error('Provide a valid email address or omit it.');
    if (body.activeJob != null && typeof body.activeJob !== 'boolean') throw new Error('Active job must be true or false.');
    if (body.bookingDetails != null && !isNewService(input)) throw new Error('Booking details are only for new customer service requests.');
    if (isNewService(input)) {
      const details = body.bookingDetails;
      if (!isObject(details) || hasExtra(details, BOOKING_FIELDS)) throw new Error('Provide structured service request details.');
      const available = catalog?.subcategories;
      if (!available) throw new Error('Service information is unavailable.');
      if (!Array.isArray(details.services) || details.services.length < 1 || details.services.length > 7
          || details.services.some(service => typeof service !== 'string' || !Object.hasOwn(available, service))
          || new Set(details.services).size !== details.services.length) throw new Error('Choose distinct, exact service categories from the current catalog.');
      if (details.items != null && (!Array.isArray(details.items) || details.items.length > 15)) throw new Error('Use at most 15 grouped item lines; describe additional scope in the summary.');
      const items = (details.items || []).map(item => {
        if (!isObject(item) || hasExtra(item, ITEM_FIELDS) || !details.services.includes(item.service)
            || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new Error('Each item needs a selected service and a whole quantity between 1 and 99.');
        return { service: item.service, description: text(item.description, 100, 'Item description', true), quantity: item.quantity };
      });
      input.bookingDetails = { services: [...details.services], items,
        address: text(details.address, 250, 'Service address'), postalCode: text(details.postalCode, 10, 'ZIP code'),
        requestedDate: text(details.requestedDate, 100, 'Requested date'), requestedWindow: text(details.requestedWindow, 100, 'Requested window'),
        siteNotes: text(details.siteNotes, 300, 'Site notes'), productNotes: text(details.productNotes, 400, 'Product notes'),
        readiness: text(details.readiness, 30, 'Readiness') || 'not_sure',
      };
      if (input.bookingDetails.postalCode && !/^\d{5}(?:-\d{4})?$/.test(input.bookingDetails.postalCode)) throw new Error('Provide a valid US ZIP code or omit it.');
      if (!['ready', 'not_ready', 'not_sure'].includes(input.bookingDetails.readiness)) throw new Error('Readiness must be ready, not_ready or not_sure.');
    }
    const description = supportDescription(input);
    // The existing Case helper truncates at 5000. Never silently lose details.
    if (description.length > 5000) throw new Error('The request is too long. Condense repeated details, then confirm the revised summary before saving.');
    return { value: input, description };
  } catch (error) { return { error: error.message }; }
}

export function missingSupportDetails(input) {
  const missing = [];
  if (!input.city) missing.push('city');
  if (!input.email) missing.push('email (optional)');
  if (isNewService(input)) {
    const job = input.bookingDetails;
    for (const [key, label] of [['address', 'service address'], ['postalCode', 'ZIP code'], ['requestedDate', 'preferred service date'], ['requestedWindow', 'preferred service window']]) {
      if (!job[key]) missing.push(label);
    }
    if (!job.items.length) missing.push('item details/quantities');
    if (job.readiness === 'not_sure') missing.push('site/product readiness');
  } else if (!input.jobReference && !['application', 'account', 'availability'].includes(input.topic)) missing.push('job reference, if applicable');
  return missing;
}

export function supportDescription(input) {
  const label = SUPPORT_TOPICS[input.callerRole][input.topic][0];
  const lines = [
    `Sora ${input.callerRole === 'customer' ? 'Customer' : 'Easer / Service Pro'} request. Caller identity and any job reference are NOT verified.`,
    `Caller: ${input.name}`, `Callback: ${input.phone}`, `Email: ${input.email || 'Not provided'}`,
    `City: ${input.city || 'Not provided'}`, `Topic: ${label}`,
    `Active job reported: ${input.activeJob ? 'Yes (caller report)' : 'Not reported'}`,
    `Job reference (unverified): ${input.jobReference || 'Not provided'}`, `Summary: ${input.summary}`,
    `Requested outcome: ${input.requestedOutcome || 'Follow up about this request'}`,
    `Preferred callback time (not promised): ${input.preferredCallbackTime || 'Not specified'}`,
  ];
  if (input.bookingDetails) {
    const job = input.bookingDetails;
    lines.push(`Services: ${job.services.join('; ')}`, `Service address: ${job.address || 'Not provided'}`,
      `ZIP code: ${job.postalCode || 'Not provided'}`, `Preferred service date (not confirmed): ${job.requestedDate || 'Not specified'}`,
      `Preferred service window (not confirmed): ${job.requestedWindow || 'Not specified'}`,
      `Readiness (caller report): ${job.readiness}`, `Product / project notes: ${job.productNotes || 'Not provided'}`,
      `Site notes (no access codes): ${job.siteNotes || 'Not provided'}`,
      'Items are caller descriptions, NOT priced or verified catalog selections:',
      ...job.items.map(item => `- ${item.quantity} x ${item.description} [${item.service}]`));
  }
  lines.push(`Still to clarify: ${missingSupportDetails(input).join('; ') || 'No listed intake gaps; verify scope and availability before confirming.'}`,
    'Caller confirmed these details and permitted a callback. No SMS or marketing consent inferred.',
    'REQUEST ONLY: no booking confirmed, payment taken, account accessed, dispatch sent, cancellation/refund processed, or payout changed.',
    'Owner: verify identity/assignment before disclosing private information or changing an existing job. Emergency reports require human follow-up; this case is not emergency dispatch.');
  return lines.join('\n');
}

function authorized(req, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof req.headers?.authorization !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(req.headers.authorization);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createSupportHandler({ env = process.env, catalog = getBookingCatalog, supabase = getSupabase,
  createCase = createOperationCase, appendEvent = appendOperationCaseEvent, email = options => sendEmail(options),
  ownerAddress = ownerEmail, newRef = buildOperationCaseRef, durableLimit = hasDurableRateLimit, limit = rateLimitKey,
  now = () => new Date(),
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    if (env.TELNYX_AI_INTAKE_ENABLED !== 'true') return res.status(503).json({ error: 'Assistant intake is not enabled.' });
    if (!authorized(req, env.TELNYX_AI_TOOL_SECRET)) return res.status(401).json({ error: 'Unauthorized.' });
    const body = req.body;
    if (!isObject(body)) return res.status(400).json({ error: 'A request object is required.' });
    if (body.action === 'support_options') {
      if (Object.keys(body).length !== 1) return res.status(400).json({ error: 'Unexpected options fields.' });
      let services = [];
      try { services = Object.keys(catalog().subcategories); } catch { /* Support must remain available when the catalog fails. */ }
      return res.status(200).json({ requestsEnabled: supportIntakeEnabled(env), services,
        topics: Object.fromEntries(Object.entries(SUPPORT_TOPICS).map(([role, topics]) => [role,
          Object.entries(topics).map(([topic, [label]]) => ({ topic, label }))])),
        ...supportHours(now()), bookingCreated: false, accountAccessEnabled: false,
        message: 'Collect and confirm requests only. Do not promise appointments, staffing, prices, callbacks or completed account actions.' });
    }
    if (body.action !== 'submit_request') return res.status(400).json({ error: 'Unsupported action.' });
    if (!supportIntakeEnabled(env)) return res.status(503).json({ error: 'Detailed support intake is not enabled. Please use the contact page.', bookingCreated: false });
    let source;
    if (isNewService(body)) {
      try { source = catalog(); } catch { return res.status(503).json({ error: 'Service information is temporarily unavailable. Please use the contact page.' }); }
    }
    const validated = validateSupportRequest(body, source);
    if (validated.error) return res.status(400).json({ error: validated.error, bookingCreated: false });
    try {
      if (!durableLimit()) return res.status(503).json({ error: 'Intake is temporarily unavailable. Please use the contact page.' });
      if (!await limit('telnyx-ai:intake', 'default')) return res.status(429).json({ error: 'Please try again shortly or use the contact page.' });
    } catch { return res.status(503).json({ error: 'Intake is temporarily unavailable. Please use the contact page.' }); }
    const input = validated.value;
    const [label, caseType, priority] = SUPPORT_TOPICS[input.callerRole][input.topic];
    const severity = input.activeJob && priority === 'normal' ? 'high' : priority;
    const proposedRef = newRef('AI');
    let sb, saved;
    try {
      sb = supabase();
      saved = await createCase(sb, {
        caseRef: proposedRef, caseType, severity, source: 'system',
        // Same prefix as existing customer intake so a retry/role switch cannot create another case.
        sourceRef: `telnyx-ai:${input.callRef}`, subject: `Sora ${input.callerRole === 'customer' ? 'Customer' : 'Service Pro'}: ${label}`,
        description: validated.description, customerName: input.callerRole === 'customer' ? input.name : null,
        customerPhone: input.callerRole === 'customer' ? input.phone : null,
        customerEmail: input.callerRole === 'customer' ? input.email || null : null,
        bookingId: null, easerId: null, createdByType: 'system', createdByName: 'Sora (unverified intake)',
        metadata: { channel: 'telnyx_ai', intakeVersion: 2, conversationId: input.callRef,
          callerRole: input.callerRole, topic: input.topic, identityVerified: false,
          detailsConfirmed: true, callbackConsent: true, bookingCreated: false, activeJobReported: input.activeJob },
      });
      if (!saved?.id || !saved.case_ref) throw new Error('Case was not persisted.');
    } catch { return res.status(503).json({ error: 'Your request could not be saved. Please use the contact page.', bookingCreated: false }); }
    if (saved.description !== validated.description) return res.status(409).json({ error: 'This call already has a different confirmed request. Contact support with the saved reference to make a correction.', bookingCreated: false });
    if (saved.case_ref === proposedRef) {
      let notice;
      try {
        notice = await email({ to: ownerAddress(), from: 'AssembleAtEase <contact@assembleatease.com>',
          subject: `${severity === 'critical' ? 'URGENT ' : ''}Sora ${input.callerRole === 'customer' ? 'customer' : 'Service Pro'} request ${saved.case_ref}`,
          html: `<h2>${esc(label)}</h2><p>Reference: ${esc(saved.case_ref)} | Priority: ${esc(severity)}</p><p style="white-space:pre-wrap">${esc(validated.description)}</p><p>Open Owner Dashboard &gt; Cases to acknowledge, verify and follow up. This is not a confirmed booking or account action.</p>`,
          meta: { operationCaseId: saved.id, notificationType: input.callerRole === 'customer' ? 'ai_customer_intake_owner' : 'ai_pro_support_owner', recipientType: 'owner' },
        });
      } catch { notice = { ok: false }; }
      try {
        await appendEvent(sb, { caseId: saved.id, eventType: 'notification_attempted', actorType: 'system', actorName: 'Notifications',
          note: notice?.providerAccepted === true ? 'Owner alert accepted by the email provider; delivery is not yet confirmed.'
            : 'Owner alert not confirmed as accepted. The saved request needs follow-up in Cases.',
          metadata: { channel: 'email', providerAccepted: notice?.providerAccepted === true, deliveryConfirmed: false,
            logged: notice?.logged === true, suppressed: notice?.suppressed === true },
        });
      } catch { console.warn('Sora intake notification timeline needs review:', createHash('sha256').update(saved.id).digest('hex').slice(0, 12)); }
    }
    return res.status(200).json({ success: true, ref: saved.case_ref, status: 'received',
      bookingCreated: false, appointmentConfirmed: false, paymentTaken: false, accountChanged: false,
      identityVerified: false, callbackTimeConfirmed: false,
      message: 'Your request is saved for follow-up. No appointment or callback time is confirmed, and no payment or account change has been made.' });
  };
}

export default createSupportHandler();
