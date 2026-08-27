import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';

export const config = { api: { bodyParser: false } };

/**
 * POST /api/webhooks/telnyx — inbound SMS and delivery events.
 *
 * Telnyx signs every webhook with Ed25519. Unlike Resend (which uses svix), the
 * signature is over `timestamp|rawBody`, so the body must be read RAW — a parsed
 * body re-serialises differently and the signature will never match. Hence
 * bodyParser: false.
 *
 * WHAT THIS ENDPOINT IS FOR
 *   1. STOP / opt-out. Telnyx blocks further messages to a number that texts
 *      STOP, but without this the platform would never know: the dashboard would
 *      keep reporting "sent" for a number the carrier is silently dropping. TCPA
 *      compliance is the provider's job; KNOWING about it is ours.
 *   2. Delivery truth. 'sent' means the provider accepted it, not that it
 *      arrived. Same distinction migration 068 draws for email.
 *   3. Inbound replies, which is what makes accept-by-reply possible later.
 *
 * Everything is recorded against notification_log with channel = 'sms', reusing
 * the delivery-truth columns email already writes to, so one owner view covers
 * both channels rather than a second parallel system.
 *
 * Verification is REQUIRED. An unsigned or unverifiable request is rejected —
 * this endpoint is public, and without that check anyone could forge an opt-out
 * for a number, or a delivery confirmation for a message that never arrived.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const publicKey = (process.env.TELNYX_PUBLIC_KEY || '').trim();
  const signature = header(req, 'telnyx-signature-ed25519');
  const timestamp = header(req, 'telnyx-timestamp');

  if (!publicKey) {
    console.error('[telnyx-webhook] TELNYX_PUBLIC_KEY is not configured');
    return res.status(503).json({ error: 'Webhook verification is not configured' });
  }
  if (!signature || !timestamp) {
    return res.status(400).json({ error: 'Missing Telnyx signature headers' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error('[telnyx-webhook] body read failed:', error?.message || error);
    return res.status(400).json({ error: 'Invalid webhook body' });
  }

  // Reject anything older than five minutes so a captured request cannot be
  // replayed later to fake an opt-out or a delivery.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return res.status(400).json({ error: 'Webhook timestamp outside the accepted window' });
  }

  if (!verifyTelnyxSignature({ publicKey, signature, timestamp, rawBody })) {
    console.warn('[telnyx-webhook] signature rejected');
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Webhook body is not valid JSON' });
  }

  const payload = event?.data?.payload || {};
  const eventType = String(event?.data?.event_type || '').toLowerCase();
  const sb = getSupabase();

  try {
    if (eventType === 'message.received') {
      await handleInbound(sb, payload);
    } else if (['message.sent', 'message.finalized'].includes(eventType)) {
      await handleDeliveryStatus(sb, payload, eventType);
    }
  } catch (error) {
    // Never 500 a webhook for a processing fault: the provider would retry the
    // same event indefinitely. Record it and acknowledge.
    console.error('[telnyx-webhook] processing failed:', eventType, error?.message || error);
  }

  // Always 200 once the signature is valid, so Telnyx stops retrying.
  return res.status(200).json({ ok: true, eventType });
}

/**
 * Inbound text. The only body we act on today is an opt-out keyword — the
 * carrier has already stopped delivery at that point, so this records the fact
 * rather than enforcing it.
 */
async function handleInbound(sb, payload) {
  const from = normalizePhone(payload?.from?.phone_number);
  const text = String(payload?.text || '').trim();
  const upper = text.toUpperCase();
  // The keyword set carriers honour automatically.
  const isOptOut = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(upper);
  const isOptIn = ['START', 'YES', 'UNSTOP'].includes(upper);

  await sb.from('notification_log').insert({
    channel: 'sms',
    notification_type: isOptOut ? 'sms_opt_out' : isOptIn ? 'sms_opt_in' : 'sms_inbound',
    recipient_type: 'unknown',
    recipient_email: null,
    subject: `Inbound SMS from ${from || 'unknown'}`,
    status: 'delivered',
    provider_id: payload?.id || null,
    error_text: text.slice(0, 500),
  }).then(() => {}, (e) => console.error('[telnyx-webhook] inbound log failed:', e?.message || e));

  // Mirror the carrier's decision into our own data. Telnyx already blocks the
  // number; without this the platform would keep queueing messages into a void
  // and reporting them as sent. Matched on the raw and E.164 forms because
  // profiles store whatever the applicant typed.
  const phoneVariants = [from, from?.replace(/^\+1/, ''), from?.replace(/^\+/, '')].filter(Boolean);
  if (isOptOut && phoneVariants.length) {
    const stamp = new Date().toISOString();
    await sb.from('profiles')
      .update({ sms_opted_out_at: stamp, sms_opt_out_keyword: upper })
      .in('phone', phoneVariants)
      .then(() => {}, (e) => console.error('[telnyx-webhook] opt-out write failed:', e?.message || e));
    await sb.from('bookings')
      .update({ sms_opted_out_at: stamp })
      .in('customer_phone', phoneVariants)
      .is('sms_opted_out_at', null)
      .then(() => {}, () => { /* best effort */ });
  }

  // START / YES is re-consent. It lifts the opt-out, because that is exactly
  // what opting back in means.
  if (isOptIn && phoneVariants.length) {
    await sb.from('profiles')
      .update({
        sms_opted_out_at: null,
        sms_opt_out_keyword: null,
        sms_consent_at: new Date().toISOString(),
        sms_consent_source: 'sms_reply_start',
      })
      .in('phone', phoneVariants)
      .then(() => {}, (e) => console.error('[telnyx-webhook] opt-in write failed:', e?.message || e));
  }
}

/**
 * Delivery status. Telnyx reports per-recipient state inside `to[]`, so the
 * worst status across recipients is the one that matters for a single-recipient
 * transactional message.
 */
async function handleDeliveryStatus(sb, payload, eventType) {
  const providerId = payload?.id;
  if (!providerId) return;

  const recipientStatus = Array.isArray(payload?.to) && payload.to.length
    ? String(payload.to[0]?.status || '').toLowerCase()
    : '';
  const status = mapStatus(eventType, recipientStatus);
  if (!status) return;

  const errorText = payload?.errors?.length
    ? payload.errors.map(e => e?.detail || e?.title).filter(Boolean).join('; ').slice(0, 500)
    : null;

  await sb.from('notification_log')
    .update({
      status,
      error_text: errorText,
      last_provider_event_at: new Date().toISOString(),
      last_provider_event_type: eventType,
    })
    .eq('provider_id', providerId)
    .eq('channel', 'sms')
    .then(() => {}, (e) => console.error('[telnyx-webhook] status update failed:', e?.message || e));
}

function mapStatus(eventType, recipientStatus) {
  if (eventType === 'message.sent') return 'sent';
  const map = {
    delivered: 'delivered',
    sending_failed: 'failed',
    delivery_failed: 'failed',
    delivery_unconfirmed: 'delivery_delayed',
    expired: 'failed',
  };
  return map[recipientStatus] || null;
}

/**
 * Ed25519 over `timestamp|rawBody`, exactly as Telnyx signs it. The portal gives
 * the public key base64-encoded; Node needs it wrapped as a DER SPKI key.
 */
function verifyTelnyxSignature({ publicKey, signature, timestamp, rawBody }) {
  try {
    const signed = Buffer.from(`${timestamp}|${rawBody}`, 'utf8');
    const sig = Buffer.from(signature, 'base64');
    if (sig.length !== 64) return false;

    const raw = Buffer.from(publicKey, 'base64');
    if (raw.length !== 32) return false;
    // DER prefix for an Ed25519 SubjectPublicKeyInfo.
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      raw,
    ]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, signed, key, sig);
  } catch (error) {
    console.warn('[telnyx-webhook] verification error:', error?.message || error);
    return false;
  }
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : null;
}

function header(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : (value || '');
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
