import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';

const MAX_BODY_BYTES = 128 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  const username = String(process.env.THUMBTACK_WEBHOOK_USERNAME || '');
  const password = String(process.env.THUMBTACK_WEBHOOK_PASSWORD || '');
  if (!username || !password) return res.status(503).json({ error: 'Webhook authentication is not configured' });
  if (!validBasicAuth(req.headers?.authorization, username, password)) return res.status(401).json({ error: 'Unauthorized' });
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (contentLength > MAX_BODY_BYTES) return res.status(413).json({ error: 'Webhook payload too large' });
  const event = req.body && typeof req.body === 'object' ? req.body : null;
  if (!event || Array.isArray(event)) return res.status(400).json({ error: 'Expected a JSON event' });
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_BODY_BYTES) return res.status(413).json({ error: 'Webhook payload too large' });

  const type = clean(event.eventType || event.event_type || event.type || event.name, 80);
  if (!type) return res.status(400).json({ error: 'Missing Thumbtack event type' });
  if (!/negotiation|lead|message/i.test(type)) return res.status(200).json({ received: true, ignored: true });
  const data = event.data && typeof event.data === 'object' ? event.data : event.payload && typeof event.payload === 'object' ? event.payload : event;
  const negotiation = data.negotiation || data.lead || data;
  const message = data.message || (type.toLowerCase().includes('message') ? data : null);
  const negotiationId = clean(negotiation.negotiationID || negotiation.negotiationId || negotiation.negotiation_id || data.negotiationID || data.negotiationId, 120);
  if (!negotiationId) return res.status(400).json({ error: 'Missing Thumbtack lead ID' });

  const occurredAt = iso(event.createdAt || event.created_at || data.createdAt || data.sentAt || message?.sentAt || negotiation.createTime) || new Date().toISOString();
  const messageId = clean(message?.messageID || message?.messageId || message?.id, 120);
  const externalEventId = clean(event.eventID || event.eventId || event.id || messageId, 120);
  const eventKey = externalEventId ? `${type}:${externalEventId}` : `${type}:${crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
  const summary = leadSummary(negotiation);
  const leadPrice = centsValue(negotiation);
  const text = typeof message?.text === 'string' ? message.text : summary.description || '';
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 500) || null;

  try {
    const { data: saved, error } = await getSupabase().rpc('record_thumbtack_webhook_event_v1', {
      p_event_key: eventKey,
      p_negotiation_id: negotiationId,
      p_event_type: type,
      p_occurred_at: occurredAt,
      p_service: summary.service,
      p_city: summary.city,
      p_state: summary.state,
      p_lead_status: negotiation.status || null,
      p_lead_created_at: iso(negotiation.createTime || negotiation.createdAt || event.createdAt || event.created_at),
      p_lead_price_cents: leadPrice,
      p_message_preview: preview,
      p_message_at: message ? iso(message.sentAt || occurredAt) : null,
    });
    if (error) throw error;
    return res.status(200).json({ received: true, duplicate: saved === false });
  } catch (error) {
    console.error('[thumbtack-webhook] event persistence failed:', error?.message || error);
    return res.status(503).json({ error: 'Thumbtack event could not be saved' });
  }
}

function clean(value, max) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : ''; }
function iso(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null; }
function centsValue(negotiation) {
  const cents = negotiation.leadPriceInCents ?? negotiation.leadPriceCents ?? negotiation.leadPrice?.amountInCents ?? negotiation.leadPrice?.cents;
  if (cents != null) { const n = Number(cents); return Number.isSafeInteger(n) && n >= 0 && n <= 100000000 ? n : null; }
  const dollars = negotiation.leadPrice?.amount ?? negotiation.leadPrice;
  if (dollars == null || dollars === '') return null;
  const n = Number(dollars);
  // Whole-number leadPrice values are ambiguous (dollars vs cents). Leave them
  // unknown for owner verification rather than inventing a financial amount.
  if (Number.isInteger(n)) return null;
  const amount = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : -1;
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 100000000 ? amount : null;
}
function leadSummary(negotiation) {
  const request = negotiation.request && typeof negotiation.request === 'object' ? negotiation.request : {};
  const location = negotiation.customer?.location || request.location || negotiation.location || {};
  const rawCategory = request.category || negotiation.category || negotiation.service || {};
  const category = rawCategory && typeof rawCategory === 'object' ? rawCategory : {};
  return {
    service: clean(category.name || (typeof rawCategory === 'string' ? rawCategory : '') || negotiation.serviceName || negotiation.serviceType, 160) || null,
    city: clean(location.city || negotiation.city, 100) || null,
    state: clean(location.state || negotiation.state, 30) || null,
    description: typeof request.description === 'string' ? request.description : typeof negotiation.description === 'string' ? negotiation.description : '',
  };
}
function validBasicAuth(header, expectedUser, expectedPassword) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(header || ''));
  if (!match) return false;
  let decoded;
  try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return false; }
  const split = decoded.indexOf(':');
  if (split < 1) return false;
  const actualUser = Buffer.from(decoded.slice(0, split));
  const actualPassword = Buffer.from(decoded.slice(split + 1));
  const user = Buffer.from(expectedUser), pass = Buffer.from(expectedPassword);
  return actualUser.length === user.length && actualPassword.length === pass.length
    && crypto.timingSafeEqual(actualUser, user) && crypto.timingSafeEqual(actualPassword, pass);
}

export { centsValue, leadSummary, validBasicAuth };
