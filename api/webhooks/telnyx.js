import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';
import { recordSmsConversationMessage } from '../_sms-conversations.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

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
 *      keep reporting "sent" for a number the carrier is silently dropping.
 *      Provider-level blocking does not replace our consent records or checks.
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
  if (!['message.received', 'message.sent', 'message.finalized'].includes(eventType)) {
    return res.status(200).json({ ok: true, ignored: true });
  }
  const occurredAt = validTimestamp(event?.data?.occurred_at);
  if (!payload.id || !occurredAt) {
    return res.status(400).json({ error: 'Incomplete Telnyx message event' });
  }

  try {
    const sb = getSupabase();
    if (eventType === 'message.received') {
      await handleInbound(sb, payload, occurredAt);
    } else {
      await handleDeliveryStatus(sb, payload, eventType, occurredAt);
    }
  } catch (error) {
    // Telnyx retries failed deliveries. A 200 here would permanently lose an
    // opt-out or delivery receipt whenever Supabase is unavailable.
    console.error('[telnyx-webhook] processing failed:', eventType, error?.message || error);
    return res.status(503).json({ error: 'Webhook event could not be saved' });
  }

  // Acknowledge only after persistence succeeds (or a newer event already won).
  return res.status(200).json({ ok: true, eventType });
}

/**
 * Inbound text. The only body we act on today is an opt-out keyword — the
 * carrier has already stopped delivery at that point, so this records the fact
 * rather than enforcing it.
 */
async function handleInbound(sb, payload, stamp) {
  const from = normalizePhone(payload?.from?.phone_number);
  const text = String(payload?.text || '').trim();
  const upper = text.toUpperCase();
  // The keyword set carriers honour automatically.
  const isOptOut = ['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(upper);
  const isOptIn = ['START', 'UNSTOP'].includes(upper);

  // Mirror the carrier's decision into our own data. Telnyx already blocks the
  // number; without this the platform would keep queueing messages into a void
  // and reporting them as sent. Matched on the raw and E.164 forms because
  // profiles store whatever the applicant typed.
  const phoneVariants = [from, from?.replace(/^\+1/, ''), from?.replace(/^\+/, '')].filter(Boolean);
  if (isOptOut && phoneVariants.length) {
    await requireWrite(currentConsentOnly(sb.from('profiles')
      .update({ sms_opted_out_at: stamp, sms_opt_out_keyword: upper })
      .in('phone', phoneVariants), stamp));
    await requireWrite(currentConsentOnly(sb.from('bookings')
      .update({ sms_opted_out_at: stamp })
      .in('customer_phone', phoneVariants), stamp));
  }

  // Match Telnyx's documented restart keywords. A conversational "YES" is not
  // carrier re-consent and must not silently lift a previous opt-out.
  if (isOptIn && phoneVariants.length) {
    await requireWrite(currentConsentOnly(sb.from('profiles')
      .update({
        sms_opted_out_at: null,
        sms_opt_out_keyword: null,
        sms_consent_at: stamp,
        sms_consent_source: 'sms_reply_start',
      })
      .in('phone', phoneVariants), stamp, true));
    await requireWrite(currentConsentOnly(sb.from('bookings')
      .update({
        sms_opted_out_at: null,
        sms_consent_at: stamp,
        sms_consent_source: 'sms_reply_start',
      })
      .in('customer_phone', phoneVariants), stamp, true));
  }

  // Durable log and owner alert FIRST — they must survive even if the inbox
  // write below fails. Six delivered texts were lost because the inbox record
  // ran before them and threw, killing the whole event and Telnyx's retries.
  await requireWrite(sb.from('notification_log').upsert({
    id: inboundNotificationId(payload.id),
    channel: 'sms',
    notification_type: isOptOut ? 'sms_opt_out' : isOptIn ? 'sms_opt_in' : 'sms_inbound',
    recipient_type: 'unknown',
    recipient_email: from,
    subject: `Inbound SMS from ${from || 'unknown'}`,
    status: 'delivered',
    provider_id: payload.id,
    error_text: text.slice(0, 500),
    last_provider_event_at: stamp,
    last_provider_event_type: 'message.received',
  }, { onConflict: 'id', ignoreDuplicates: true }));

  // Owner alert, immediate: a text that lands silently costs exactly what the
  // verification code cost — the owner only knew about it an hour later.
  // Sent only on non-keyword texts (a bare STOP/START needs no alert), and a
  // failed alert never blocks the webhook: the inbox record is the truth.
  if (!isOptOut && !isOptIn) {
    // Skip the email if this exact provider message already alerted — Telnyx
    // retries and multi-endpoint delivery can send the same event twice.
    try {
      const { data: existingAlert } = await sb.from('notification_log')
        .select('id')
        .eq('channel', 'email')
        .eq('notification_type', 'owner_sms_inbound_alert')
        .eq('provider_id', `sms-alert:${payload.id}`)
        .maybeSingle();
      if (existingAlert) return;
    } catch { /* if the lookup fails, still try to alert rather than stay silent */ }
    try {
      const alertResult = await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `New text to (979) 232-5139 from ${from || 'unknown number'}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0a1628">
  <h2 style="margin:0 0 10px;font-size:18px">New text message to the business line</h2>
  <p style="font-size:13px;color:#64748b;margin:0 0 12px">From <strong>${esc(from || 'unknown')}</strong> · ${esc(new Date(stamp).toLocaleString('en-US', { timeZone: 'America/Chicago' }))}</p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(text)}</div>
  <p style="margin:16px 0"><a href="https://www.assembleatease.com/owner" style="display:inline-block;background:#00BFFF;color:#04222c;font-weight:800;text-decoration:none;padding:11px 20px;border-radius:8px">Open Messages</a></p>
  <p style="font-size:12px;color:#64748b">Received by the AssembleAtEase business number. Replies go out through the owner dashboard Messages view.</p>
</div>`,
        meta: { notificationType: 'owner_sms_inbound_alert', recipientType: 'owner', disableDedupe: true },
      });
      // Stamp the alert's log row with the SMS provider ID so a retried webhook
      // sees the previous alert and never emails twice.
      if (alertResult?.ok) {
        await sb.from('notification_log')
          .update({ provider_id: `sms-alert:${payload.id}` })
          .eq('channel', 'email')
          .eq('notification_type', 'owner_sms_inbound_alert')
          .eq('recipient_email', ownerEmail())
          .order('sent_at', { ascending: false })
          .limit(1)
          .then(() => {}, (e) => console.error('[telnyx-webhook] alert stamp failed:', e?.message || e));
      }
    } catch (alertError) {
      console.error('[telnyx-webhook] owner inbound alert failed:', alertError?.message || alertError);
    }
  }

  // Inbox record LAST. If the table/migration is ever missing again, the log
  // and alert above have already run — the text is not lost, the owner is
  // notified, and the failure is recorded where it can be seen instead of
  // dying in a 503 retry storm.
  try {
    await recordSmsConversationMessage(sb, {
      phone: from,
      body: text,
      direction: 'inbound',
      sender: 'system',
      status: 'received',
      providerId: payload.id,
      occurredAt: stamp,
    });
  } catch (inboxError) {
    console.error('[telnyx-webhook] inbox record failed for', payload.id, inboxError?.message || inboxError);
    try {
      await sb.from('operational_events').insert({
        event_type: 'sms_inbox_write_failed',
        route: '/api/webhooks/telnyx',
        method: 'POST',
        actor_role: 'system',
        stage: 'inbound_inbox',
        reason_code: 'inbox_record_failed',
        reason_detail: String(inboxError?.message || inboxError).slice(0, 300),
        mutation_result: 'log_and_alert_survived',
        payload: { provider_id: payload.id, from },
      });
    } catch { /* if even the event log fails, nothing more can be done here */ }
  }
}

function currentConsentOnly(query, stamp, isOptIn = false) {
  // Conditions are evaluated in the UPDATE itself, including concurrent events.
  // Use provider occurrence time, not retry arrival time. STOP wins a time tie.
  return query
    .or(`sms_consent_at.is.null,sms_consent_at.lte.${stamp}`)
    .or(`sms_opted_out_at.is.null,sms_opted_out_at.${isOptIn ? 'lt' : 'lte'}.${stamp}`);
}

function inboundNotificationId(providerId) {
  const bytes = crypto.createHash('sha256').update(`telnyx:inbound:${providerId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Delivery status. Telnyx reports per-recipient state inside `to[]`, so the
 * worst status across recipients is the one that matters for a single-recipient
 * transactional message.
 */
async function handleDeliveryStatus(sb, payload, eventType, occurredAt) {
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

  let update = sb.from('notification_log')
    .update({
      status,
      error_text: errorText,
      last_provider_event_at: occurredAt,
      last_provider_event_type: eventType,
    })
    .eq('provider_id', providerId)
    .eq('channel', 'sms')
    .or(`last_provider_event_at.is.null,last_provider_event_at.lte.${occurredAt}`);
  if (eventType === 'message.sent') {
    // A delayed "sent" webhook must not erase delivered/failed/unconfirmed.
    update = update.in('status', ['queued', 'provider_accepted', 'sent']);
  }
  const changed = await requireWrite(update.select('id'));
  if (!changed?.length) {
    const existing = await requireWrite(sb.from('notification_log')
      .select('id').eq('provider_id', providerId).eq('channel', 'sms').limit(1));
    // Delivery can race the sender's notification insert. Ask Telnyx to retry
    // if that row has not arrived yet; stale events for existing rows are safe.
    if (!existing?.length) throw new Error('SMS notification record is not available yet');
  }
}

async function requireWrite(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString();
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
