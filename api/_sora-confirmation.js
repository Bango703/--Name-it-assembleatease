import { createHash } from 'node:crypto';

const ASSISTANT_ID = 'assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84';
const READBACK = 'are those details correct, and may our team call you about this request?';
const normalize = value => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const UNAVAILABLE = { ok: false, status: 503, error: 'Caller confirmation could not be verified. Do not claim this request is saved. Ask the caller to confirm again after the readback, or offer the contact page.' };
const NOT_CONFIRMED = { ok: false, status: 400, error: 'Read back the request and ask: Are those details correct, and may our team call you about this request? Stop and wait for a separate caller reply of yes before calling this tool. Do not invent the caller reply.' };

// The model's detailsConfirmed/callbackConsent booleans are not evidence.
// Accept only a separate user-role reply after the most recent spoken readback
// in the provider conversation belonging to this exact call and assistant.
export function inspectSoraConfirmation(messages, { phone, now = Date.now() } = {}) {
  if (!Array.isArray(messages)) return NOT_CONFIRMED;
  const turns = messages.filter(m => ['user', 'assistant'].includes(m?.role)
    && typeof m.text === 'string' && m.text.trim() && Number.isFinite(Date.parse(m.created_at)))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const userIndex = turns.findLastIndex(m => m.role === 'user');
  const user = turns[userIndex];
  const readback = turns[userIndex - 1];
  if (!user || readback?.role !== 'assistant' || !normalize(readback.text).includes(READBACK)) return NOT_CONFIRMED;
  const reply = normalize(user.text).replace(/[.!?,]/g, '').trim();
  // Deliberately narrow: mixed answers/corrections must be clarified, not guessed.
  if (!/^(yes|yes please|yes thats correct|yes that is correct|yes correct|yes send it|yes please send it|yes save it|yes you may call me|correct|thats correct|that is correct)$/.test(reply.replace(/['’]/g, ''))) return NOT_CONFIRMED;
  const age = now - Date.parse(user.created_at);
  if (age < -30000 || age > 15 * 60 * 1000 || Date.parse(user.created_at) <= Date.parse(readback.created_at)) return NOT_CONFIRMED;
  const callbackDigits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (callbackDigits.length !== 10 || !readback.text.replace(/\D/g, '').includes(callbackDigits)) return NOT_CONFIRMED;
  return { ok: true, evidence: {
    provider: 'telnyx', method: 'separate_caller_reply_after_readback',
    readbackAt: readback.created_at, confirmedAt: user.created_at,
    messageDigest: createHash('sha256').update(readback.text + '\n' + user.text).digest('hex'),
  } };
}

export async function verifySoraConfirmation({ callControlId, phone, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  if (!env.TELNYX_API_KEY || typeof callControlId !== 'string') return UNAVAILABLE;
  const get = async path => {
    const response = await fetchImpl('https://api.telnyx.com/v2' + path, {
      headers: { Authorization: 'Bearer ' + env.TELNYX_API_KEY }, signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error('Provider confirmation unavailable');
    return response.json();
  };
  try {
    const query = new URLSearchParams({ 'metadata->call_control_id': 'eq.' + callControlId,
      'metadata->assistant_id': 'eq.' + ASSISTANT_ID, limit: '2', order: 'created_at.desc' });
    const conversations = await get('/ai/conversations?' + query);
    if (!Array.isArray(conversations.data) || conversations.data.length !== 1) return UNAVAILABLE;
    const conversation = conversations.data[0];
    if (!/^[a-f0-9-]{36}$/i.test(conversation.id || '')
        || conversation.metadata?.call_control_id !== callControlId
        || conversation.metadata?.assistant_id !== ASSISTANT_ID) return UNAVAILABLE;
    const page = await get('/ai/conversations/' + conversation.id + '/messages?page[size]=100&page[number]=1');
    if (!Array.isArray(page.data)) return UNAVAILABLE;
    const result = inspectSoraConfirmation(page.data, { phone, now });
    if (!result.ok) return result;
    return { ok: true, evidence: { ...result.evidence, conversationId: conversation.id } };
  } catch { return UNAVAILABLE; }
}
