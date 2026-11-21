import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { buildRequestId, insertOperationalEventFailOpen } from '../_observability.js';
import { personaOutcome, verifyPersonaSignature } from '../_persona.js';
import { recordIdentityRetry, recordIdentityVerified } from '../_identity-outcome.js';

/**
 * POST /api/webhook/persona: Persona inquiry events (api/_persona.js).
 *
 * Signed with PERSONA_WEBHOOK_SECRET (Persona dashboard > Webhooks). An
 * unsigned, mis-signed or replayed request changes nothing. The inquiry's
 * reference-id is the Easer's profile id, set when we created it, and an event
 * for an inquiry that is not the profile's current one is ignored, so an old
 * attempt can never overwrite a newer result.
 *
 * Replies 200 for anything handled or deliberately ignored, 401 for a bad
 * signature, and 503 when our own write failed, so Persona retries.
 * Profile writes are idempotent and every email is keyed to the event, so a
 * retry never sends twice.
 */
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function logEvent(sb, { requestId, eventName, inquiryId, outcome, statusCode, reason = null }) {
  return insertOperationalEventFailOpen(sb, {
    request_id: requestId,
    event_type: 'persona_webhook',
    route: '/api/webhook/persona',
    method: 'POST',
    actor_role: 'system',
    stage: outcome,
    status_code: statusCode,
    reason_code: reason,
    payload: { eventName, inquiryId, outcome },
  });
}

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const secret = deps.secret ?? process.env.PERSONA_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Persona webhook secret is not configured' });

  const rawBody = deps.rawBody ?? await readRawBody(req);
  const signature = req.headers['persona-signature'];
  if (!verifyPersonaSignature(rawBody, signature, secret, { nowMs: deps.nowMs })) {
    return res.status(401).json({ error: 'Invalid Persona signature' });
  }

  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    return res.status(400).json({ error: 'Body is not JSON' });
  }

  const sb = deps.sb || getSupabase();
  const record = deps.recordVerified || recordIdentityVerified;
  const retry = deps.recordRetry || recordIdentityRetry;
  const requestId = buildRequestId(req.headers || {});
  const eventId = event?.data?.id || null;
  const eventName = event?.data?.attributes?.name || null;
  const inquiry = event?.data?.attributes?.payload?.data || null;
  const inquiryId = inquiry?.id || null;
  const profileId = inquiry?.attributes?.['reference-id'] || inquiry?.attributes?.referenceId || null;
  const outcome = personaOutcome(eventName);

  if (outcome === 'ignore' || !inquiryId) {
    await logEvent(sb, { requestId, eventName, inquiryId, outcome: 'ignored', statusCode: 200 });
    return res.status(200).json({ received: true, ignored: true });
  }
  if (!profileId) {
    await logEvent(sb, { requestId, eventName, inquiryId, outcome: 'ignored', statusCode: 200, reason: 'no_reference_id' });
    return res.status(200).json({ received: true, ignored: true, reason: 'no reference id' });
  }

  try {
    const { data: profile, error } = await sb.from('profiles')
      .select('id, role, full_name, email, persona_inquiry_id, identity_verified')
      .eq('id', profileId)
      .maybeSingle();
    if (error) throw new Error(`Profile lookup failed: ${error.message || error}`);
    if (!profile || profile.role !== 'assembler') {
      await logEvent(sb, { requestId, eventName, inquiryId, outcome: 'ignored', statusCode: 200, reason: 'no_easer_profile' });
      return res.status(200).json({ received: true, ignored: true, reason: 'no Easer profile' });
    }
    if (profile.persona_inquiry_id && profile.persona_inquiry_id !== inquiryId) {
      await logEvent(sb, { requestId, eventName, inquiryId, outcome: 'ignored', statusCode: 200, reason: 'stale_inquiry' });
      return res.status(200).json({ received: true, ignored: true, reason: 'stale inquiry' });
    }

    const key = `persona:${eventId || `${inquiryId}:${eventName}`}`;
    const referenceUpdates = { persona_inquiry_id: inquiryId, identity_provider: 'persona' };
    if (outcome === 'verified') {
      if (profile.identity_verified === true) {
        await logEvent(sb, { requestId, eventName, inquiryId, outcome: 'already_verified', statusCode: 200 });
        return res.status(200).json({ received: true, alreadyVerified: true });
      }
      await record(sb, { userId: profileId, profile, referenceUpdates, context: 'Persona verified state', notificationKey: key });
    } else if (outcome === 'retry') {
      if (profile.identity_verified === true) {
        await logEvent(sb, { requestId, eventName, inquiryId, outcome: 'ignored', statusCode: 200, reason: 'already_verified' });
        return res.status(200).json({ received: true, ignored: true, reason: 'already verified' });
      }
      await retry(sb, { userId: profileId, profile, referenceUpdates, reason: 'the ID check did not pass', context: 'Persona retry state', notificationKey: key });
    } else if (outcome === 'review') {
      const reviewEmail = {
        to: ownerEmail(),
        subject: `ID check needs your review in Persona: ${esc(profile.full_name || 'Easer applicant')}`,
        html: `<p><strong>${esc(profile.full_name || 'An applicant')}</strong> finished the ID check and Persona marked it for review.</p>
          <p>Open the inquiry in the Persona dashboard and approve or decline it. Persona sends the result here, and the profile updates on its own.</p>
          <p>Inquiry: ${esc(inquiryId)}</p>`,
        meta: { notificationType: 'identity_review_owner', recipientType: 'owner', notificationKey: `${key}:owner` },
      };
      await (deps.sendEmail ? deps.sendEmail(reviewEmail) : sendEmail(reviewEmail));
    }
    await logEvent(sb, { requestId, eventName, inquiryId, outcome, statusCode: 200 });
    return res.status(200).json({ received: true, outcome });
  } catch (error) {
    console.error('[persona-webhook]', error?.message || error);
    await logEvent(sb, { requestId, eventName, inquiryId, outcome: 'failed', statusCode: 503, reason: 'db_write_failed' });
    return res.status(503).json({ received: false, error: 'Could not record the Persona result. Persona will retry.' });
  }
}
