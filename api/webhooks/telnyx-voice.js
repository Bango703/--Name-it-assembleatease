import { getSupabase } from '../_supabase.js';
import { voiceConfig, verifyVoiceSignature, parseVoiceEvent } from '../_voice-call-history.js';

export const config = { api: { bodyParser: false } };
const MAX_BYTES = 32768;

export function createVoiceWebhook({ env = process.env, supabase = getSupabase, now = Date.now } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
    const settings = voiceConfig(env);
    if (!settings.enabled) return res.status(503).json({ error: 'Call history is not enabled' });
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['application/json', 'application/x-www-form-urlencoded'].includes(contentType)) return res.status(415).json({ error: 'Unsupported content type' });
    let raw;
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > MAX_BYTES) return res.status(413).json({ error: 'Payload too large' });
        chunks.push(bytes);
      }
      raw = Buffer.concat(chunks);
    } catch { return res.status(400).json({ error: 'Unable to read event' }); }
    const receivedAt = now();
    if (!verifyVoiceSignature(raw, req.headers || {}, settings.publicKey, receivedAt)) return res.status(401).json({ error: 'Invalid event signature' });
    let event;
    try { event = parseVoiceEvent(raw, contentType, settings, receivedAt); }
    catch { return res.status(400).json({ error: 'Invalid call event' }); }
    if (event.forbidden) return res.status(403).json({ error: 'Connection not allowed' });
    if (event.ignored) return res.status(200).json({ ignored: true });
    try {
      // Stable primary key + DO NOTHING makes concurrent retries harmless. A success
      // response means durable storage, never merely an attempted notification.
      const { error } = await supabase().from('activity_logs').upsert(event.row, { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw new Error('Storage unavailable');
      return res.status(200).json({ received: true });
    } catch { return res.status(503).json({ error: 'Call event could not be saved; retry required' }); }
  };
}

export default createVoiceWebhook();
