import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { AI_CATEGORIES } from '../_ai-assist.js';
import {
  aiAssistEnabled,
  autoReplyEnabled,
  draftForCase,
  draftForMessage,
  draftForText,
  isMissingAiAssistTable,
  messagesNeedingReply,
  reconcileDrafts,
  textsNeedingReply,
} from '../_ai-assist-runner.js';

// Owner dashboard: the AI suggestion for a booking thread, a text conversation
// or a case. Reading never sends anything. "Use this reply" in the dashboard
// only fills the owner's own reply box; the owner's Send does the sending.
//
//   GET  ?bookingId= | ?smsConversationId= | ?caseId=
//   POST { action: 'draft', bookingId | smsConversationId | caseId, audience?, redo? }
//   POST { action: 'dismiss', draftId }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_PRIORITY_LABELS = { low: 'Low priority', normal: 'Normal priority', high: 'High priority', urgent: 'Urgent' };

export function publicDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    audience: row.audience || null,
    category: row.category || null,
    categoryLabel: row.kind === 'case' ? (CASE_PRIORITY_LABELS[row.category] || null) : (AI_CATEGORIES[row.category] || null),
    routine: row.routine === true,
    urgent: row.urgent === true,
    summary: row.summary || null,
    nextStep: row.next_step || null,
    draft: row.draft_body || '',
    reviewNote: row.review_note || null,
    status: row.status,
    error: row.status === 'failed' ? (row.error_text || 'The suggestion could not be written.') : null,
    createdAt: row.created_at,
  };
}

function setupNeeded(res) {
  return res.status(200).json({
    enabled: false,
    setupNeeded: true,
    reason: 'AI suggestions need database migration 135 (ai_assist_drafts).',
    drafts: [],
    waiting: [],
  });
}

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();
  const enabled = aiAssistEnabled();
  const base = { enabled, autoReply: autoReplyEnabled(), reason: enabled ? null : 'AI suggestions are off (AI_ASSIST_ENABLED or ANTHROPIC_API_KEY).' };

  try {
    if (req.method === 'GET') return await read(req, res, sb, base);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const action = String(req.body?.action || '');
    if (action === 'dismiss') return await dismiss(req, res, sb);
    if (action === 'draft') {
      if (!enabled) return res.status(409).json({ error: base.reason, code: 'AI_ASSIST_OFF' });
      return await draft(req, res, sb, base);
    }
    return res.status(400).json({ error: 'Choose draft or dismiss.' });
  } catch (error) {
    if (isMissingAiAssistTable(error)) return setupNeeded(res);
    console.error('[ai-assist] owner request failed:', error?.message || error);
    return res.status(500).json({ error: 'The AI suggestion could not be loaded. Refresh to try again.' });
  }
}

async function bookingWaiting(sb, bookingId) {
  const { data: messages, error } = await sb.from('messages')
    .select('id, booking_id, sender, recipient_type, body, created_at')
    .eq('booking_id', bookingId).order('created_at', { ascending: true }).limit(200);
  if (error) throw error;
  return messagesNeedingReply(messages || []);
}

async function textWaiting(sb, conversationId) {
  const { data: texts, error } = await sb.from('sms_messages')
    .select('id, conversation_id, booking_id, direction, body, occurred_at')
    .eq('conversation_id', conversationId).order('occurred_at', { ascending: true }).limit(100);
  if (error) throw error;
  return textsNeedingReply(texts || []);
}

async function read(req, res, sb, base) {
  const { bookingId, smsConversationId, caseId } = req.query || {};
  if (bookingId) {
    if (!UUID_RE.test(String(bookingId))) return res.status(400).json({ error: 'A valid bookingId is required.' });
    await reconcileDrafts(sb, { bookingId });
    const waiting = await bookingWaiting(sb, bookingId);
    const ids = waiting.map((w) => w.message.id);
    const { data: rows, error } = ids.length
      ? await sb.from('ai_assist_drafts').select('*').eq('kind', 'message').in('source_message_id', ids)
      : { data: [], error: null };
    if (error) throw error;
    const bySource = new Map((rows || []).map((r) => [r.source_message_id, r]));
    return res.status(200).json({
      ...base,
      drafts: waiting.map((w) => bySource.get(w.message.id)).filter((r) => r && r.status !== 'dismissed').map(publicDraft),
      waiting: waiting.map((w) => ({ messageId: w.message.id, audience: w.audience, hasSuggestion: bySource.has(w.message.id) })),
    });
  }
  if (smsConversationId) {
    if (!UUID_RE.test(String(smsConversationId))) return res.status(400).json({ error: 'A valid smsConversationId is required.' });
    await reconcileDrafts(sb, { smsConversationId });
    const waiting = await textWaiting(sb, smsConversationId);
    const ids = waiting.map((t) => t.id);
    const { data: rows, error } = ids.length
      ? await sb.from('ai_assist_drafts').select('*').in('source_sms_id', ids)
      : { data: [], error: null };
    if (error) throw error;
    const bySource = new Map((rows || []).map((r) => [r.source_sms_id, r]));
    return res.status(200).json({
      ...base,
      drafts: waiting.map((t) => bySource.get(t.id)).filter((r) => r && r.status !== 'dismissed').map(publicDraft),
      waiting: waiting.map((t) => ({ smsId: t.id, hasSuggestion: bySource.has(t.id) })),
    });
  }
  if (caseId) {
    if (!UUID_RE.test(String(caseId))) return res.status(400).json({ error: 'A valid caseId is required.' });
    const { data: operationCase, error: caseError } = await sb.from('operations_cases').select('id, status').eq('id', caseId).maybeSingle();
    if (caseError) throw caseError;
    if (!operationCase) return res.status(404).json({ error: 'Case not found' });
    const { data: rows, error } = await sb.from('ai_assist_drafts').select('*')
      .eq('case_id', caseId).order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    const latest = rows?.[0];
    const open = !['resolved', 'closed'].includes(operationCase.status);
    return res.status(200).json({
      ...base,
      drafts: latest && ['pending', 'drafted', 'failed'].includes(latest.status) ? [publicDraft(latest)] : [],
      waiting: open && (!latest || latest.status === 'superseded') ? [{ caseId }] : [],
    });
  }
  return res.status(400).json({ error: 'Pass bookingId, smsConversationId or caseId.' });
}

async function draft(req, res, sb, base) {
  const { bookingId, smsConversationId, caseId, audience, redo } = req.body || {};
  const force = redo === true;
  let row = null;
  if (bookingId) {
    if (!UUID_RE.test(String(bookingId))) return res.status(400).json({ error: 'A valid bookingId is required.' });
    const waiting = await bookingWaiting(sb, bookingId);
    const pick = waiting.filter((w) => !audience || w.audience === audience).pop();
    if (!pick) return res.status(409).json({ error: 'Nothing in this booking is waiting for a reply.', code: 'NOTHING_WAITING' });
    row = await draftForMessage(sb, pick, { force });
  } else if (smsConversationId) {
    if (!UUID_RE.test(String(smsConversationId))) return res.status(400).json({ error: 'A valid smsConversationId is required.' });
    const waiting = await textWaiting(sb, smsConversationId);
    const pick = waiting.pop();
    if (!pick) return res.status(409).json({ error: 'No text in this conversation is waiting for a reply.', code: 'NOTHING_WAITING' });
    row = await draftForText(sb, pick, { force });
  } else if (caseId) {
    if (!UUID_RE.test(String(caseId))) return res.status(400).json({ error: 'A valid caseId is required.' });
    const { data: operationCase, error } = await sb.from('operations_cases').select('*').eq('id', caseId).maybeSingle();
    if (error) throw error;
    if (!operationCase) return res.status(404).json({ error: 'Case not found' });
    if (['resolved', 'closed'].includes(operationCase.status)) return res.status(409).json({ error: 'This case is closed.', code: 'CASE_CLOSED' });
    row = await draftForCase(sb, operationCase, { force });
  } else {
    return res.status(400).json({ error: 'Pass bookingId, smsConversationId or caseId.' });
  }
  if (!row) return res.status(409).json({ error: 'A suggestion is already being written. Refresh in a moment.', code: 'DRAFT_IN_PROGRESS' });
  return res.status(200).json({ ...base, draft: publicDraft(row) });
}

async function dismiss(req, res, sb) {
  const draftId = String(req.body?.draftId || '');
  if (!UUID_RE.test(draftId)) return res.status(400).json({ error: 'A valid draftId is required.' });
  const { data, error } = await sb.from('ai_assist_drafts')
    .update({ status: 'dismissed', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', draftId).in('status', ['drafted', 'failed']).select('id').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(409).json({ error: 'This suggestion was already used or replaced. Refresh to see the latest.', code: 'DRAFT_NOT_OPEN' });
  return res.status(200).json({ success: true });
}
