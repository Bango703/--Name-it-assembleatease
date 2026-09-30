import { overflowConfig, parseOverflowClientState, isUnansweredHumanFailure, buildOverflowAnswer,
  buildOverflowTransfer, buildOverflowMachineHangup, buildOverflowAssistantStart, buildOverflowSpeech, buildOverflowHangup,
  sendTelnyxCommand, telnyxCallControlEvent, isOverflowInbound, overflowCommandReference } from '../_telnyx-overflow.js';
import { verifyVoiceSignature } from '../_voice-call-history.js';

export const config = { api: { bodyParser: false } };
const MAX_BYTES = 32768;

async function readRawBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BYTES) throw new Error('Payload too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function statusForCommand(result) {
  return result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429 ? 422 : 503;
}

export function createTelnyxOverflowWebhook({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

    const settings = overflowConfig(env);
    if (!settings.enabled) return res.status(503).json({ error: 'Call overflow is not enabled' });
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return res.status(415).json({ error: 'Unsupported content type' });

    let raw;
    try { raw = await readRawBody(req); }
    catch (error) { return res.status(error.message === 'Payload too large' ? 413 : 400).json({ error: 'Invalid call event' }); }
    if (!verifyVoiceSignature(raw, req.headers || {}, settings.publicKey, now())) return res.status(401).json({ error: 'Invalid event signature' });

    let event;
    try { event = telnyxCallControlEvent(raw); }
    catch { return res.status(400).json({ error: 'Invalid call event' }); }
    const { type, payload } = event;
    if (payload.connection_id !== settings.connectionId) return res.status(403).json({ error: 'Connection not allowed' });

    if (type === 'call.initiated') {
      if (!isOverflowInbound(payload, settings)) return res.status(200).json({ ignored: 'not an approved inbound call' });
      const callControlId = payload.call_control_id;
      const result = await sendTelnyxCommand(settings, callControlId, 'answer', buildOverflowAnswer(settings, callControlId), fetchImpl);
      if (!result.ok) {
        console.error('[telnyx-overflow] inbound answer command failed', overflowCommandReference(callControlId), result.status || 'network');
        return res.status(statusForCommand(result)).json({ error: 'Inbound call could not be answered by the overflow application' });
      }
      return res.status(200).json({ received: true, action: 'answered' });
    }

    if (type === 'call.answered') {
      const state = parseOverflowClientState(payload.client_state);
      if (!state || state.stage !== 'caller' || payload.call_control_id !== state.callerCallControlId) {
        return res.status(200).json({ ignored: 'not the caller leg' });
      }
      const result = await sendTelnyxCommand(settings, state.callerCallControlId, 'transfer',
        buildOverflowTransfer(settings, state.callerCallControlId), fetchImpl);
      if (result.ok) return res.status(200).json({ received: true, action: 'human transfer started' });
      if (result.ambiguous || result.status >= 500 || result.status === 408 || result.status === 429) {
        console.error('[telnyx-overflow] human transfer result uncertain', overflowCommandReference(state.callerCallControlId), result.status || 'network');
        return res.status(503).json({ error: 'Human transfer result is uncertain; retry required' });
      }
      return startAssistant(settings, state.callerCallControlId, fetchImpl, res, 'human transfer rejected');
    }

    if (type === 'call.hangup') {
      const state = parseOverflowClientState(payload.client_state);
      if (state?.stage === 'machine_hangup') {
        return startAssistant(settings, state.callerCallControlId, fetchImpl, res, 'human destination reached voicemail');
      }
      if (!state || state.stage !== 'human_transfer' || !isUnansweredHumanFailure(payload)) {
        return res.status(200).json({ ignored: 'human transfer did not fail unanswered' });
      }
      return startAssistant(settings, state.callerCallControlId, fetchImpl, res, 'human transfer unanswered');
    }

    if (type === 'call.machine.detection.ended') {
      const state = parseOverflowClientState(payload.client_state);
      if (!state || state.stage !== 'human_transfer' || payload.result !== 'machine'
        || typeof payload.call_control_id !== 'string') {
        return res.status(200).json({ ignored: 'human or uncertain answer' });
      }
      const result = await sendTelnyxCommand(settings, payload.call_control_id, 'hangup',
        buildOverflowMachineHangup(payload.call_control_id, state.callerCallControlId), fetchImpl);
      if (result.ok) return res.status(200).json({ received: true, action: 'voicemail leg ended' });
      if (!result.ambiguous && result.code === '90018') {
        return startAssistant(settings, state.callerCallControlId, fetchImpl, res, 'human destination reached voicemail');
      }
      console.error('[telnyx-overflow] voicemail leg could not be ended', overflowCommandReference(state.callerCallControlId), result.status || 'network');
      return res.status(503).json({ error: 'Voicemail leg could not be ended; retry required' });
    }

    if (type === 'call.speak.ended') {
      const state = parseOverflowClientState(payload.client_state);
      if (!state || state.stage !== 'fallback_speech' || payload.call_control_id !== state.callerCallControlId) {
        return res.status(200).json({ ignored: 'not the overflow fallback message' });
      }
      const result = await sendTelnyxCommand(settings, state.callerCallControlId, 'hangup',
        buildOverflowHangup(state.callerCallControlId), fetchImpl);
      if (!result.ok) return res.status(503).json({ error: 'Fallback call could not be ended; retry required' });
      return res.status(200).json({ received: true, action: 'fallback message ended' });
    }

    return res.status(200).json({ ignored: type });
  };
}

async function startAssistant(settings, callerCallControlId, fetchImpl, res, reason) {
  const result = await sendTelnyxCommand(settings, callerCallControlId, 'ai_assistant_start',
    buildOverflowAssistantStart(settings, callerCallControlId), fetchImpl);
  if (result.ok) return res.status(200).json({ received: true, action: 'Sora started', reason });
  if (result.code === '90061') return res.status(200).json({ received: true, action: 'Sora already active', reason });
  if (result.ambiguous || result.status >= 500 || result.status === 408 || result.status === 429) {
    console.error('[telnyx-overflow] Sora start result uncertain', overflowCommandReference(callerCallControlId), result.status || 'network');
    return res.status(503).json({ error: 'Sora start result is uncertain; retry required' });
  }

  const speech = await sendTelnyxCommand(settings, callerCallControlId, 'speak',
    buildOverflowSpeech(callerCallControlId), fetchImpl);
  if (!speech.ok) {
    console.error('[telnyx-overflow] spoken fallback unavailable', overflowCommandReference(callerCallControlId), speech.status || 'network');
    return res.status(503).json({ error: 'Call fallback is unavailable; retry required' });
  }
  console.error('[telnyx-overflow] Sora start rejected; spoken fallback used', overflowCommandReference(callerCallControlId), result.status || 'unknown');
  return res.status(200).json({ received: true, action: 'spoken fallback started', reason });
}

export default createTelnyxOverflowWebhook();
