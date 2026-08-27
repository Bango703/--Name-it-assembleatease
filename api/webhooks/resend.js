import { Webhook } from 'svix';
import { getSupabase } from '../_supabase.js';

export const config = { api: { bodyParser: false } };

const EMAIL_EVENTS = new Set([
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.suppressed',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const svixId = header(req, 'svix-id');
  const svixTimestamp = header(req, 'svix-timestamp');
  const svixSignature = header(req, 'svix-signature');
  if (!secret || !svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ error: 'Missing Resend webhook signature configuration' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error('[resend-webhook] body read failed:', error?.message || error);
    return res.status(400).json({ error: 'Invalid webhook body' });
  }

  let event;
  try {
    event = new Webhook(secret).verify(rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
  } catch (error) {
    console.warn('[resend-webhook] signature rejected:', error?.message || error);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  if (!EMAIL_EVENTS.has(event?.type)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const providerId = String(event?.data?.email_id || '').trim();
  const eventCreatedAt = validTimestamp(event?.created_at) || validTimestamp(event?.data?.created_at);
  if (!providerId || !eventCreatedAt) {
    return res.status(400).json({ error: 'Incomplete Resend email event' });
  }

  const sb = getSupabase();
  const { data, error } = await sb.rpc('apply_resend_delivery_event_v1', {
    p_svix_id: svixId,
    p_provider_id: providerId,
    p_event_type: event.type,
    p_event_created_at: eventCreatedAt,
    p_payload: event,
  });
  if (error) {
    console.error('[resend-webhook] delivery event persistence failed:', error.message || error);
    return res.status(503).json({ error: 'Webhook event could not be saved' });
  }

  const result = Array.isArray(data) ? data[0] : data;
  return res.status(200).json({
    received: true,
    duplicate: result?.event_recorded === false,
    notificationFound: result?.notification_found === true,
    status: result?.notification_status || null,
  });
}

function header(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : String(value || '').trim();
}

function validTimestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

