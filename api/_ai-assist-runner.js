import { messageNeedsOwner } from './_owner-inbox.js';
import { createOwnerSessionToken } from './_email.js';
import { loadBookingItems } from './booking/_booking-items.js';
import {
  AUTO_REPLY_NOTE,
  AiAssistError,
  aiAssistClient,
  assessCase,
  assessMessage,
} from './_ai-assist.js';

// AI assist, the database side: which messages, texts and cases need a
// suggestion, saving it, and recording what the owner did with it. The rules
// for what a suggestion says and when it may send live in api/_ai-assist.js.
//
// Flags (Vercel env):
//   AI_ASSIST_ENABLED      on unless set to "false"; needs ANTHROPIC_API_KEY.
//   AI_AUTO_REPLY_ENABLED  off unless set to "true". When on, a routine reply
//                          to a customer on a booking thread sends without the
//                          owner, through the owner's own send path.

const ACTIVE = ['pending', 'drafted'];
const LOOKBACK_HOURS = 48;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60 * 1000;

export function aiAssistEnabled(env = process.env) {
  return String(env.AI_ASSIST_ENABLED || '').toLowerCase() !== 'false' && Boolean(env.ANTHROPIC_API_KEY);
}

export function autoReplyEnabled(env = process.env) {
  return aiAssistEnabled(env) && String(env.AI_AUTO_REPLY_ENABLED || '').toLowerCase() === 'true';
}

export function isMissingAiAssistTable(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return error?.code === '42P01' || error?.code === 'PGRST205' || /ai_assist_drafts/.test(text) && /does not exist|schema cache|could not find/i.test(text);
}

const sameText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

// ── Pure decisions (tested directly) ─────────────────────────────────────────

/**
 * The latest message from each party (customer, Easer) in each booking thread
 * that is still waiting for the owner. A message the owner has answered, or one
 * followed by a newer message from the same party, needs nothing here.
 */
export function messagesNeedingReply(messages = []) {
  const latest = new Map();
  const sorted = [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const m of sorted) {
    if (!m?.booking_id) continue;
    const party = m.sender === 'owner' ? m.recipient_type : m.sender;
    if (!['customer', 'assembler'].includes(party)) continue;
    // Only the owner thread with that party counts; a direct customer-Easer
    // exchange is not waiting for the owner.
    const ownerThread = m.sender === 'owner' || messageNeedsOwner(m);
    if (!ownerThread) continue;
    latest.set(`${m.booking_id}:${party}`, { message: m, party });
  }
  return [...latest.values()]
    .filter(({ message }) => messageNeedsOwner(message))
    .map(({ message, party }) => ({ message, audience: party }));
}

/**
 * What became of an open suggestion, given what was written after the message
 * it answers: the owner's reply (same text or edited), a newer message from the
 * same person (the suggestion is out of date), or nothing yet (null).
 */
export function draftOutcome(draft, laterMessages = []) {
  const ownerReply = laterMessages.find((m) => m.sender === 'owner'
    && (draft.kind === 'sms' || m.recipient_type === draft.audience));
  if (ownerReply) {
    const auto = String(ownerReply.body || '').includes(AUTO_REPLY_NOTE);
    return {
      status: auto ? 'auto_sent' : (sameText(ownerReply.body, draft.draft_body) ? 'sent' : 'edited_sent'),
      sentMessageId: ownerReply.id || null,
    };
  }
  const newer = laterMessages.find((m) => m.sender !== 'owner'
    && (draft.kind === 'sms' || m.sender === draft.audience));
  if (newer) return { status: 'superseded', sentMessageId: null };
  return null;
}

/** The newest inbound text per conversation that has no reply after it. */
export function textsNeedingReply(texts = []) {
  const byConversation = new Map();
  for (const t of [...texts].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at))) {
    if (t?.conversation_id) byConversation.set(t.conversation_id, t);
  }
  return [...byConversation.values()].filter((t) => t.direction === 'inbound');
}

// ── Sending as the owner ─────────────────────────────────────────────────────

/**
 * Send through POST /api/booking/message exactly as the dashboard does, with a
 * short-lived owner session, so an automatic reply gets the same checks,
 * notifications and history as one the owner typed.
 */
export async function sendAsOwner({ bookingId, target, body }) {
  const session = createOwnerSessionToken();
  if (!session) throw new AiAssistError('Owner sessions are not configured, so nothing can send automatically.', 'OWNER_SESSION_MISSING');
  const { default: messageHandler } = await import('./booking/message.js');
  let status = 200;
  let payload = null;
  const res = {
    status(code) { status = code; return this; },
    json(data) { payload = data; return this; },
    setHeader() { return this; },
  };
  await messageHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'x-forwarded-for': 'ai-assist' },
    body: { bookingId, sender: 'owner', target, body },
    query: {},
    socket: {},
  }, res);
  if (status !== 200 || !payload?.success) {
    throw new AiAssistError(payload?.error || `The reply was not sent (${status}).`, 'AUTO_SEND_FAILED');
  }
  return payload;
}

// ── Database ─────────────────────────────────────────────────────────────────

async function loadBookingContext(sb, bookingId) {
  if (!bookingId) return null;
  const { data: booking } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
  if (!booking) return null;
  // Items through the one reader the owner and Easer screens use.
  let items = [];
  try {
    const groups = (await loadBookingItems(bookingId, { sb })).get(bookingId) || [];
    items = groups.flatMap((group) => group.items.map((item) => ({ name: item.addOnName ? `${item.name} (${item.addOnName})` : item.name, quantity: item.quantity })));
  } catch (error) {
    console.error('[ai-assist] booking items could not be read:', error?.message || error);
  }
  return { ...booking, items };
}

/** Claim a row so two runs never write two suggestions for one source. */
async function claim(sb, row) {
  const { data, error } = await sb.from('ai_assist_drafts').insert({ ...row, status: 'pending' }).select('*').single();
  if (!error) return { draft: data, claimed: true };
  if (error.code === '23505') return { draft: null, claimed: false };
  throw error;
}

async function retryFailed(sb, draft) {
  if (draft.status !== 'failed' || draft.attempts >= MAX_ATTEMPTS) return null;
  if (Date.now() - new Date(draft.updated_at).getTime() < RETRY_AFTER_MS) return null;
  const { data } = await sb.from('ai_assist_drafts')
    .update({ status: 'pending', attempts: draft.attempts + 1, updated_at: new Date().toISOString() })
    .eq('id', draft.id).eq('status', 'failed').eq('attempts', draft.attempts)
    .select('*').maybeSingle();
  return data || null;
}

async function saveFailure(sb, draft, error) {
  await sb.from('ai_assist_drafts').update({
    status: 'failed',
    error_text: String(error?.message || error || 'Unknown error').slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq('id', draft.id).eq('status', 'pending');
}

/** Write (or rewrite) the suggestion for one booking message. */
export async function draftForMessage(sb, { message, audience }, { client = aiAssistClient(), force = false } = {}) {
  let { draft, claimed } = await claim(sb, {
    kind: 'message',
    booking_id: message.booking_id,
    source_message_id: message.id,
    source_created_at: message.created_at,
    audience,
  });
  if (!claimed) {
    const { data: existing } = await sb.from('ai_assist_drafts').select('*').eq('source_message_id', message.id).maybeSingle();
    if (!existing) return null;
    if (force && ['drafted', 'failed', 'dismissed'].includes(existing.status)) {
      const { data } = await sb.from('ai_assist_drafts')
        .update({ status: 'pending', attempts: Math.min((existing.attempts || 1) + 1, 10), error_text: null, updated_at: new Date().toISOString() })
        .eq('id', existing.id).eq('status', existing.status).select('*').maybeSingle();
      draft = data;
    } else {
      draft = await retryFailed(sb, existing);
    }
    if (!draft) return existing;
  }
  try {
    const booking = await loadBookingContext(sb, message.booking_id);
    const { data: thread } = await sb.from('messages')
      .select('id, sender, recipient_type, body, created_at')
      .eq('booking_id', message.booking_id)
      .order('created_at', { ascending: true })
      .limit(60);
    const result = await assessMessage({ client, kind: 'message', audience, booking, thread: thread || [], inbound: message });
    const { data: saved } = await sb.from('ai_assist_drafts').update({
      status: 'drafted',
      category: result.category,
      routine: result.routine,
      urgent: result.urgent,
      summary: result.summary,
      draft_body: result.reply,
      review_note: result.reviewNote,
      model: result.model,
      error_text: null,
      updated_at: new Date().toISOString(),
    }).eq('id', draft.id).eq('status', 'pending').select('*').maybeSingle();
    // Older open suggestions for the same person on this booking are out of date.
    await sb.from('ai_assist_drafts').update({ status: 'superseded', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('booking_id', message.booking_id).eq('kind', 'message').eq('audience', audience)
      .in('status', ACTIVE).neq('id', draft.id).lt('source_created_at', message.created_at);
    return saved || draft;
  } catch (error) {
    await saveFailure(sb, draft, error);
    return { ...draft, status: 'failed', error_text: error?.message || String(error) };
  }
}

/** Write (or rewrite) the suggestion for one inbound text. Texts never send on their own. */
export async function draftForText(sb, text, { client = aiAssistClient(), force = false } = {}) {
  const { data: conversation } = await sb.from('sms_conversations').select('id, booking_id, easer_id').eq('id', text.conversation_id).maybeSingle();
  const audience = conversation?.easer_id ? 'easer' : 'customer';
  let { draft, claimed } = await claim(sb, {
    kind: 'sms',
    booking_id: text.booking_id || conversation?.booking_id || null,
    source_sms_id: text.id,
    sms_conversation_id: text.conversation_id,
    source_created_at: text.occurred_at,
    audience,
  });
  if (!claimed) {
    const { data: existing } = await sb.from('ai_assist_drafts').select('*').eq('source_sms_id', text.id).maybeSingle();
    if (!existing) return null;
    if (force && ['drafted', 'failed', 'dismissed'].includes(existing.status)) {
      const { data } = await sb.from('ai_assist_drafts')
        .update({ status: 'pending', attempts: Math.min((existing.attempts || 1) + 1, 10), error_text: null, updated_at: new Date().toISOString() })
        .eq('id', existing.id).eq('status', existing.status).select('*').maybeSingle();
      draft = data;
    } else {
      draft = await retryFailed(sb, existing);
    }
    if (!draft) return existing;
  }
  try {
    const booking = await loadBookingContext(sb, draft.booking_id);
    const { data: texts } = await sb.from('sms_messages')
      .select('direction, sender, body, occurred_at')
      .eq('conversation_id', text.conversation_id)
      .order('occurred_at', { ascending: true })
      .limit(40);
    const thread = (texts || []).map((t) => ({
      sender: t.direction === 'outbound' ? 'owner' : (audience === 'easer' ? 'easer' : 'customer'),
      recipient_type: t.direction === 'outbound' ? audience : 'owner',
      body: t.body,
    }));
    const result = await assessMessage({ client, kind: 'sms', audience: audience === 'easer' ? 'assembler' : 'customer', booking, thread, inbound: text });
    const { data: saved } = await sb.from('ai_assist_drafts').update({
      status: 'drafted',
      category: result.category,
      routine: false,
      urgent: result.urgent,
      summary: result.summary,
      draft_body: result.reply,
      review_note: result.reviewNote,
      model: result.model,
      error_text: null,
      updated_at: new Date().toISOString(),
    }).eq('id', draft.id).eq('status', 'pending').select('*').maybeSingle();
    await sb.from('ai_assist_drafts').update({ status: 'superseded', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('sms_conversation_id', text.conversation_id).eq('kind', 'sms')
      .in('status', ACTIVE).neq('id', draft.id).lt('source_created_at', text.occurred_at);
    return saved || draft;
  } catch (error) {
    await saveFailure(sb, draft, error);
    return { ...draft, status: 'failed', error_text: error?.message || String(error) };
  }
}

/** Write the summary and suggested update for one case. Cases never send on their own. */
export async function draftForCase(sb, operationCase, { client = aiAssistClient(), force = false } = {}) {
  if (force) {
    await sb.from('ai_assist_drafts').update({ status: 'superseded', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('case_id', operationCase.id).in('status', ACTIVE);
  }
  const { draft, claimed } = await claim(sb, {
    kind: 'case',
    case_id: operationCase.id,
    booking_id: operationCase.booking_id || null,
    source_created_at: operationCase.created_at,
  });
  if (!claimed) {
    const { data: existing } = await sb.from('ai_assist_drafts').select('*').eq('case_id', operationCase.id).in('status', ACTIVE).maybeSingle();
    return existing || null;
  }
  try {
    const booking = await loadBookingContext(sb, operationCase.booking_id);
    const { data: events } = await sb.from('operations_case_events')
      .select('event_type, actor_type, note, public_message, created_at')
      .eq('case_id', operationCase.id)
      .order('created_at', { ascending: true })
      .limit(30);
    const result = await assessCase({ client, operationCase, booking, events: events || [] });
    const { data: saved } = await sb.from('ai_assist_drafts').update({
      status: 'drafted',
      category: result.priority,
      urgent: result.urgent,
      audience: result.recipient,
      summary: result.summary,
      next_step: result.nextStep,
      draft_body: result.update || null,
      review_note: result.reviewNote,
      model: result.model,
      error_text: null,
      updated_at: new Date().toISOString(),
    }).eq('id', draft.id).eq('status', 'pending').select('*').maybeSingle();
    return saved || draft;
  } catch (error) {
    await saveFailure(sb, draft, error);
    return { ...draft, status: 'failed', error_text: error?.message || String(error) };
  }
}

/** Record what became of open message and text suggestions. */
export async function reconcileDrafts(sb, { bookingId = null, smsConversationId = null } = {}) {
  let query = sb.from('ai_assist_drafts').select('*').eq('status', 'drafted').in('kind', ['message', 'sms']).limit(200);
  if (bookingId) query = query.eq('booking_id', bookingId).eq('kind', 'message');
  if (smsConversationId) query = query.eq('sms_conversation_id', smsConversationId);
  const { data: drafts, error } = await query;
  if (error) throw error;
  let changed = 0;
  for (const draft of drafts || []) {
    let later = [];
    if (draft.kind === 'message') {
      const { data } = await sb.from('messages')
        .select('id, sender, recipient_type, body, created_at')
        .eq('booking_id', draft.booking_id)
        .gt('created_at', draft.source_created_at)
        .order('created_at', { ascending: true })
        .limit(20);
      later = data || [];
    } else {
      const { data } = await sb.from('sms_messages')
        .select('id, direction, body, occurred_at')
        .eq('conversation_id', draft.sms_conversation_id)
        .gt('occurred_at', draft.source_created_at)
        .order('occurred_at', { ascending: true })
        .limit(20);
      later = (data || []).map((t) => ({ id: null, sender: t.direction === 'outbound' ? 'owner' : 'customer', body: t.body }));
    }
    const outcome = draftOutcome(draft, later);
    if (!outcome) continue;
    const { error: updateError } = await sb.from('ai_assist_drafts').update({
      status: outcome.status,
      sent_message_id: outcome.sentMessageId,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', draft.id).eq('status', 'drafted');
    if (!updateError) changed += 1;
  }
  // A case update the owner sent, or a case that closed, retires its suggestion.
  if (!bookingId && !smsConversationId) {
    const { data: caseDrafts } = await sb.from('ai_assist_drafts').select('id, case_id, draft_body, created_at').eq('kind', 'case').eq('status', 'drafted').limit(100);
    for (const draft of caseDrafts || []) {
      const { data: c } = await sb.from('operations_cases').select('status').eq('id', draft.case_id).maybeSingle();
      const { data: updates } = await sb.from('operations_case_events')
        .select('public_message, created_at').eq('case_id', draft.case_id).eq('event_type', 'public_update')
        .gt('created_at', draft.created_at).order('created_at', { ascending: true }).limit(1);
      const sent = updates?.[0];
      const status = sent ? (sameText(sent.public_message, draft.draft_body) ? 'sent' : 'edited_sent')
        : (['resolved', 'closed'].includes(c?.status) ? 'superseded' : null);
      if (!status) continue;
      await sb.from('ai_assist_drafts').update({ status, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', draft.id).eq('status', 'drafted');
      changed += 1;
    }
  }
  return changed;
}

/** Send a routine customer reply when automatic replies are on. */
export async function maybeAutoSend(sb, draft, { env = process.env, send = sendAsOwner } = {}) {
  if (!autoReplyEnabled(env)) return { sent: false, reason: 'Automatic replies are off.' };
  if (draft?.kind !== 'message' || draft.status !== 'drafted' || !draft.routine || draft.audience !== 'customer') {
    return { sent: false, reason: 'Not a routine customer reply.' };
  }
  // Still the latest thing the customer said, and still unanswered.
  const { data: later } = await sb.from('messages')
    .select('id, sender, recipient_type, body, created_at')
    .eq('booking_id', draft.booking_id)
    .gt('created_at', draft.source_created_at)
    .limit(5);
  if ((later || []).length) return { sent: false, reason: 'The thread moved on.' };
  // Claim before sending, so two runs never send twice.
  const { data: claimedRow } = await sb.from('ai_assist_drafts')
    .update({ status: 'auto_sent', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', draft.id).eq('status', 'drafted').select('id').maybeSingle();
  if (!claimedRow) return { sent: false, reason: 'Already handled.' };
  try {
    const result = await send({ bookingId: draft.booking_id, target: 'customer', body: `${draft.draft_body}\n\n${AUTO_REPLY_NOTE}` });
    await sb.from('ai_assist_drafts').update({ sent_message_id: result?.message?.id || null, updated_at: new Date().toISOString() }).eq('id', draft.id);
    return { sent: true };
  } catch (error) {
    // Nothing went out: put it back in front of the owner with the reason.
    await sb.from('ai_assist_drafts').update({
      status: 'drafted',
      routine: false,
      decided_at: null,
      review_note: `Automatic send failed: ${String(error?.message || error).slice(0, 300)}`,
      updated_at: new Date().toISOString(),
    }).eq('id', draft.id).eq('status', 'auto_sent');
    return { sent: false, reason: error?.message || 'Send failed.' };
  }
}

/** One pass: record outcomes, write new suggestions, send routine replies when allowed. */
export async function runAiAssist(sb, { env = process.env, client = aiAssistClient(env), deadlineMs = 50_000, limits = { messages: 6, texts: 3, cases: 3 } } = {}) {
  const started = Date.now();
  const timeLeft = () => Date.now() - started < deadlineMs;
  const summary = { enabled: aiAssistEnabled(env), autoReply: autoReplyEnabled(env), reconciled: 0, drafted: 0, failed: 0, autoSent: 0, errors: [] };
  if (!summary.enabled) return summary;

  summary.reconciled = await reconcileDrafts(sb);
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  // Booking messages.
  const { data: recent, error: messageError } = await sb.from('messages')
    .select('id, booking_id, sender, recipient_type, body, created_at')
    .gte('created_at', since).order('created_at', { ascending: true }).limit(800);
  if (messageError) throw messageError;
  const waiting = messagesNeedingReply(recent || []);
  const ids = waiting.map((w) => w.message.id);
  const { data: existing } = ids.length
    ? await sb.from('ai_assist_drafts').select('source_message_id, status, attempts, updated_at').in('source_message_id', ids)
    : { data: [] };
  const known = new Map((existing || []).map((row) => [row.source_message_id, row]));
  let messageBudget = limits.messages;
  for (const item of waiting) {
    if (!timeLeft() || messageBudget <= 0) break;
    const row = known.get(item.message.id);
    if (row && !(row.status === 'failed' && row.attempts < MAX_ATTEMPTS)) continue;
    messageBudget -= 1;
    const draft = await draftForMessage(sb, item, { client });
    if (draft?.status === 'drafted') {
      summary.drafted += 1;
      const auto = await maybeAutoSend(sb, draft, { env });
      if (auto.sent) summary.autoSent += 1;
    } else if (draft?.status === 'failed') {
      summary.failed += 1;
      summary.errors.push(draft.error_text);
    }
  }

  // Inbound texts.
  const { data: texts } = await sb.from('sms_messages')
    .select('id, conversation_id, booking_id, direction, body, occurred_at')
    .gte('occurred_at', since).order('occurred_at', { ascending: true }).limit(400);
  const textWaiting = textsNeedingReply(texts || []);
  const textIds = textWaiting.map((t) => t.id);
  const { data: textRows } = textIds.length
    ? await sb.from('ai_assist_drafts').select('source_sms_id, status, attempts').in('source_sms_id', textIds)
    : { data: [] };
  const knownTexts = new Map((textRows || []).map((row) => [row.source_sms_id, row]));
  let textBudget = limits.texts;
  for (const text of textWaiting) {
    if (!timeLeft() || textBudget <= 0) break;
    const row = knownTexts.get(text.id);
    if (row && !(row.status === 'failed' && row.attempts < MAX_ATTEMPTS)) continue;
    textBudget -= 1;
    const draft = await draftForText(sb, text, { client });
    if (draft?.status === 'drafted') summary.drafted += 1;
    else if (draft?.status === 'failed') { summary.failed += 1; summary.errors.push(draft.error_text); }
  }

  // Open cases without a suggestion.
  const caseSince = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const { data: cases } = await sb.from('operations_cases')
    .select('*')
    .in('status', ['open', 'acknowledged', 'in_progress', 'waiting_customer', 'waiting_easer'])
    .gte('created_at', caseSince).order('created_at', { ascending: false }).limit(30);
  const caseIds = (cases || []).map((c) => c.id);
  const { data: caseRows } = caseIds.length
    ? await sb.from('ai_assist_drafts').select('case_id').in('case_id', caseIds)
    : { data: [] };
  const assessed = new Set((caseRows || []).map((row) => row.case_id));
  let caseBudget = limits.cases;
  for (const operationCase of cases || []) {
    if (!timeLeft() || caseBudget <= 0) break;
    if (assessed.has(operationCase.id)) continue;
    caseBudget -= 1;
    const draft = await draftForCase(sb, operationCase, { client });
    if (draft?.status === 'drafted') summary.drafted += 1;
    else if (draft?.status === 'failed') { summary.failed += 1; summary.errors.push(draft.error_text); }
  }
  return summary;
}
