import { getSupabase } from '../_supabase.js';
import { verifyVoiceSignature } from '../_voice-call-history.js';
import { normalizeUsPhone } from '../_phone.js';
import { rateLimitKey } from '../_ratelimit.js';
import { logActivity } from '../booking/_activity.js';
import { sendPushToUser } from '../_push.js';
import { summarizeCall } from '../_call-summary.js';
import {
  privateLineConfig, isPoolNumber, openLinesForCaller, leadEaserId, callerGreeting, calleePrompt,
  menuPrompt, NO_LINE_MESSAGE, NO_ANSWER_MESSAGE, encodeState, decodeState,
} from '../_private-line.js';

/**
 * POST /api/webhooks/telnyx-private-line — the private customer–Easer lines
 * (api/_private-line.js). Its own Telnyx Call Control application and numbers:
 * the business number and the owner's click-to-call
 * (api/webhooks/telnyx-call-control.js) are never routed here.
 *
 * Every number dialled comes from this platform's own records or from the
 * client_state it created; nothing in a request body chooses who is called.
 */
export const config = { api: { bodyParser: false } };
const MAX_BYTES = 32768;
const API = 'https://api.telnyx.com/v2/calls';

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const publicKey = String(process.env.TELNYX_PUBLIC_KEY || '').trim();
  if (!publicKey) return res.status(503).json({ error: 'Private lines are not configured' });

  let raw;
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_BYTES) return res.status(413).json({ error: 'Payload too large' });
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read event' });
  }
  if (!(deps.verify || verifyVoiceSignature)(raw, req.headers || {}, publicKey, Date.now())) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const result = await handlePrivateLineEvent(event, {
    cfg: deps.cfg || privateLineConfig(),
    sb: deps.sb || getSupabase(),
    command: deps.command || telnyxCommand,
    now: deps.now || Date.now(),
    rateLimit: deps.rateLimit || ((key) => rateLimitKey(key, 'default')),
    notifyEaser: deps.notifyEaser || ((easerId, payload) => sendPushToUser(easerId, payload, { notificationType: 'private_line_missed_call', recipientType: 'easer' })),
    log: deps.log || logActivity,
    summarize: deps.summarize || summarizeCall,
  });
  return res.status(200).json({ ok: true, ...result });
}

/** The event logic, with every outside call injected (tested in scripts/test-private-calling.mjs). */
export async function handlePrivateLineEvent(event, ctx) {
  const { cfg, command } = ctx;
  const payload = event?.data?.payload || {};
  const type = String(event?.data?.event_type || '').toLowerCase();
  const callId = String(payload.call_control_id || '').trim();
  if (!callId) return { ignored: 'no_call_control_id' };
  const state = decodeState(payload.client_state);

  // ── A call to a pool number ──────────────────────────────────────────────
  if (type === 'call.initiated' && payload.direction === 'incoming') {
    if (!isPoolNumber(cfg, payload.to?.phone_number || payload.to)) return { ignored: 'not_a_private_line' };
    if (!cfg.enabled) {
      await command(cfg, callId, 'answer', { client_state: encodeState({ stage: 'to_business' }) });
      return { routed: 'business_line', reason: 'private_calling_off' };
    }
    const caller = normalizeUsPhone(payload.from?.phone_number || payload.from);
    if (!caller || !(await ctx.rateLimit(`private-line:${caller}`))) {
      await command(cfg, callId, 'answer', { client_state: encodeState({ stage: 'to_business' }) });
      return { routed: 'business_line', reason: caller ? 'rate_limited' : 'no_caller_id' };
    }
    const line = normalizeUsPhone(payload.to?.phone_number || payload.to);
    const lines = await openLinesForCaller(ctx.sb, caller, ctx.now);
    if (!lines.length) {
      await command(cfg, callId, 'answer', { client_state: encodeState({ stage: 'to_business' }) });
      return { routed: 'business_line', reason: 'no_open_line' };
    }
    if (lines.length > 1) {
      const shown = lines.slice(0, 5);
      await command(cfg, callId, 'answer', { client_state: encodeState({
        stage: 'menu', caller, line,
        options: shown.map((l) => l.booking.id),
        optionDates: shown.map((l) => l.booking.date || null),
        optionTimes: shown.map((l) => l.booking.time || null),
      }) });
      return { routed: 'menu', options: Math.min(lines.length, 5) };
    }
    const only = lines[0];
    await command(cfg, callId, 'answer', { client_state: encodeState({ stage: 'greeting', line, bookingId: only.booking.id, callerType: only.callerType, destination: only.destination }) });
    return { routed: 'greeting', bookingRef: only.booking.ref, callerType: only.callerType };
  }

  if (!state) return { ignored: 'not_a_private_line_event' };

  // ── Answered: the caller we picked up, or the person we rang ─────────────
  if (type === 'call.answered') {
    if (state.stage === 'to_business') {
      await command(cfg, callId, 'speak', speakBody(NO_LINE_MESSAGE, { ...state, stage: 'to_business_spoken' }));
      return { action: 'told_business_line' };
    }
    if (state.stage === 'menu') {
      await command(cfg, callId, 'gather_using_speak', {
        ...speakBody(menuPromptFor(state), state),
        valid_digits: state.options.map((_, i) => String(i + 1)).join(''),
        minimum_digits: 1, maximum_digits: 1, timeout_millis: 10000,
      });
      return { action: 'menu_played' };
    }
    if (state.stage === 'greeting' || state.stage === 'initiator') {
      await command(cfg, callId, 'speak', speakBody(callerGreeting(cfg), { ...state, stage: 'greeted' }));
      return { action: 'caller_greeted' };
    }
    if (state.stage === 'callee') {
      // The person rung hears who it is (and the recording notice) and must
      // press 1, so a voicemail greeting is never joined to the caller.
      await command(cfg, callId, 'gather_using_speak', {
        ...speakBody(calleePrompt(cfg, state.callerType), { ...state, stage: 'callee_prompt' }),
        valid_digits: '1', minimum_digits: 1, maximum_digits: 1, timeout_millis: 8000,
      });
      return { action: 'callee_prompted' };
    }
    return { ignored: 'answered_unknown_stage' };
  }

  if (type === 'call.speak.ended') {
    if (state.stage === 'to_business_spoken') {
      await command(cfg, callId, 'transfer', { to: cfg.businessNumber });
      return { action: 'transferred_to_business_line' };
    }
    if (state.stage === 'greeted') {
      const placed = await ctx.command(cfg, null, 'dial', {
        connection_id: cfg.appId,
        to: state.destination,
        from: state.line,
        from_display_name: 'AssembleAtEase',
        link_to: callId,
        bridge_on_answer: false,
        timeout_secs: 30,
        client_state: encodeState({ stage: 'callee', peer: callId, bookingId: state.bookingId, callerType: state.callerType }),
      });
      if (!placed.ok) {
        await command(cfg, callId, 'speak', speakBody('Sorry, we could not connect you right now. Please try again in a moment.', { ...state, stage: 'closing' }));
        return { action: 'dial_failed' };
      }
      return { action: 'dialing_callee' };
    }
    if (state.stage === 'closing') {
      await command(cfg, callId, 'hangup', {});
      return { action: 'hung_up' };
    }
    return { ignored: 'speak_ended_unknown_stage' };
  }

  if (type === 'call.gather.ended') {
    const digits = String(payload.digits || '');
    if (state.stage === 'menu') {
      const chosen = state.options[Number(digits) - 1];
      const lines = chosen ? await openLinesForCaller(ctx.sb, state.caller, ctx.now) : [];
      const line = lines.find((l) => l.booking.id === chosen);
      if (!line) {
        await command(cfg, callId, 'speak', speakBody('Sorry, that job is not available. Goodbye.', { ...state, stage: 'closing' }));
        return { action: 'menu_no_match' };
      }
      await command(cfg, callId, 'speak', speakBody(callerGreeting(cfg), { stage: 'greeted', line: state.line, bookingId: line.booking.id, callerType: line.callerType, destination: line.destination }));
      return { action: 'menu_chosen', bookingRef: line.booking.ref };
    }
    if (state.stage === 'callee_prompt') {
      if (digits === '1') {
        const bridged = await command(cfg, callId, 'bridge', { call_control_id: state.peer, client_state: encodeState({ ...state, stage: 'bridged' }) });
        if (!bridged.ok) {
          await command(cfg, callId, 'hangup', {});
          return { action: 'bridge_failed' };
        }
        if (cfg.recording) {
          // Dual channel (one person per channel), transcribed by Telnyx; the
          // transcript is summarized for the owner when it is saved.
          await command(cfg, state.peer, 'record_start', {
            format: 'mp3', channels: 'dual',
            transcription: true, transcription_engine: 'deepgram/nova-3', transcription_language: 'en',
            client_state: encodeState({ ...state, stage: 'bridged', recordedFrom: 'caller' }),
          });
        }
        await ctx.log(ctx.sb, {
          bookingId: state.bookingId, eventType: 'private_call_connected', actorType: 'system', actorName: 'private_line',
          description: `Private call connected (${state.callerType === 'customer' ? 'customer to Easer' : 'Easer to customer'})${cfg.recording ? ', recorded' : ''}.`,
          metadata: { callerType: state.callerType, recorded: cfg.recording },
        }).catch(() => {});
        return { action: 'bridged', recorded: cfg.recording };
      }
      await command(cfg, callId, 'hangup', {});
      await missed(ctx, state);
      return { action: 'callee_declined' };
    }
    return { ignored: 'gather_unknown_stage' };
  }

  if (type === 'call.hangup') {
    // A connected call ended: end the other side too.
    if (state.stage === 'bridged' && state.peer) {
      await command(cfg, state.peer, 'hangup', {});
      return { action: 'peer_hung_up' };
    }
    // The person rung never connected (no answer, busy, declined).
    if ((state.stage === 'callee' || state.stage === 'callee_prompt') && state.peer) {
      await missed(ctx, state);
      return { action: 'no_answer' };
    }
    return { ignored: 'hangup' };
  }

  if (type === 'call.recording.saved') {
    await ctx.log(ctx.sb, {
      bookingId: state.bookingId, eventType: 'private_call_recorded', actorType: 'system', actorName: 'private_line',
      description: 'Private call recording saved.',
      metadata: { recordingId: payload.recording_id || null, durationMillis: payload.duration_millis || null, callerType: state.callerType },
    }).catch(() => {});
    return { action: 'recording_logged' };
  }

  if (type === 'call.recording.transcription.saved') {
    const transcript = payload.transcription_text || payload.transcription?.text || payload.text || '';
    const result = await ctx.summarize({ transcript, callerType: state.callerType });
    await ctx.log(ctx.sb, {
      bookingId: state.bookingId,
      eventType: result.ok ? 'private_call_summary' : 'private_call_summary_unavailable',
      actorType: 'system', actorName: 'private_line',
      description: result.ok ? `Call summary: ${result.summary}` : `The call was recorded but could not be summarized (${result.reason}).`,
      metadata: { recordingId: payload.recording_id || null, callerType: state.callerType, model: result.model || null, reason: result.ok ? null : result.reason },
    }).catch(() => {});
    return { action: result.ok ? 'summarized' : 'summary_unavailable' };
  }

  return { ignored: type || 'unknown_event' };
}

// Tell the caller still on the line, and the person they missed.
async function missed(ctx, state) {
  const { cfg, command } = ctx;
  await command(cfg, state.peer, 'speak', speakBody(NO_ANSWER_MESSAGE, { ...state, stage: 'closing' }));
  await ctx.log(ctx.sb, {
    bookingId: state.bookingId, eventType: 'private_call_missed', actorType: 'system', actorName: 'private_line',
    description: state.callerType === 'customer' ? 'The customer called the Easer through the private line; the Easer did not pick up.' : 'The Easer called the customer through the private line; the customer did not pick up.',
    metadata: { callerType: state.callerType },
  }).catch(() => {});
  if (state.callerType === 'customer') {
    const { data: booking } = await ctx.sb.from('bookings').select('id, ref, assembler_id').eq('id', state.bookingId).maybeSingle();
    const easerId = booking ? await leadEaserId(ctx.sb, booking) : null;
    if (easerId) {
      await ctx.notifyEaser(easerId, { title: 'Missed call from your customer', body: `Call them back from job ${booking.ref}.`, url: `/assembler/my-assignments?job=${booking.id}` }).catch(() => {});
    }
  }
}

function menuPromptFor(state) {
  // The options were fixed when the call came in; the prompt only names them.
  return menuPrompt(state.options.map((id, i) => ({ booking: { id, date: state.optionDates?.[i], time: state.optionTimes?.[i] } })));
}

function speakBody(text, state) {
  return { payload: text, voice: 'female', language: 'en-US', client_state: encodeState(state) };
}

/** One Telnyx Call Control command. `dial` starts a new call; others act on callId. Never throws. */
export async function telnyxCommand(cfg, callId, action, body) {
  const url = action === 'dial' ? API : `${API}/${encodeURIComponent(callId)}/actions/${action}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return response.ok ? { ok: true, data } : { ok: false, error: data?.errors?.[0]?.detail || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
