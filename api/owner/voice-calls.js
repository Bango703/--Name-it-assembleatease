import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { CALL_REF, VOICE_EVENT, VOICE_REVIEW, voiceConfig, voiceRowId, projectVoiceCall } from '../_voice-call-history.js';

const SELECT = 'id,event_type,metadata,created_at';
const PAGE_SIZE = 80;
const CALL_LIMIT = 500;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function result(query) {
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw new Error('Read unavailable');
  return data;
}
function events(sb) { return sb.from('activity_logs').select(SELECT).is('booking_id', null).eq('event_type', VOICE_EVENT); }
async function readCall(sb, reference) {
  const rows = await result(events(sb).eq('metadata->>callReference', reference).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(CALL_LIMIT + 1));
  return { rows: rows.slice(0, CALL_LIMIT), complete: rows.length <= CALL_LIMIT };
}
function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid cursor');
  const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!UUID.test(cursor.id || '') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.at || '')
    || !Number.isFinite(Date.parse(cursor.at))) throw new Error('Invalid cursor');
  return cursor;
}
function encodeCursor(row) { return Buffer.from(JSON.stringify({ at: row.created_at, id: row.id })).toString('base64url'); }

async function enrich(sb, calls) {
  if (!calls.length) return;
  const references = calls.map(c => c.reference);
  let reviews = null, cases = null, notices = null;
  try { reviews = await result(sb.from('activity_logs').select(SELECT).eq('event_type', VOICE_REVIEW).in('id', references.map(r => voiceRowId('review:' + r))).limit(PAGE_SIZE + 1)); } catch { /* Unavailable is not zero. */ }
  try {
    cases = await result(sb.from('operations_cases').select('id,case_ref,source_ref,status,severity,subject')
      .eq('source', 'system').in('source_ref', references.map(r => 'telnyx-ai:' + r)).limit(501));
    if (cases.length > 500) cases = null;
  } catch { /* Case lookup must not hide the call. */ }
  if (cases?.length) {
    try {
      notices = await result(sb.from('notification_log')
        .select('id,operation_case_id,status,sent_at,delivered_at,bounced_at,complained_at,provider_failed_at')
        .eq('recipient_type', 'owner').in('notification_type', ['ai_customer_intake_owner', 'ai_pro_support_owner'])
        .in('operation_case_id', cases.map(c => c.id)).order('sent_at', { ascending: false }).limit(501));
      if (notices.length > 500) notices = null;
    } catch { /* Delivery remains unknown when the notification store fails. */ }
  }
  for (const call of calls) {
    const review = reviews?.find(r => r.id === voiceRowId('review:' + call.reference));
    call.reviewState = reviews === null ? 'unavailable' : call.complete && review?.metadata?.revision === call.revision ? 'reviewed' : 'unreviewed';
    call.reviewed = call.reviewState === 'reviewed';
    call.reviewedAt = review?.created_at || null;
    const linked = cases?.filter(c => c.source_ref === 'telnyx-ai:' + call.reference);
    call.requestState = cases === null ? 'unavailable' : linked.length ? 'saved' : 'none_found';
    call.cases = (linked || []).map(c => ({ id: c.id, ref: c.case_ref, status: c.status, severity: c.severity, subject: c.subject }));
    const notifications = notices?.filter(n => linked?.some(c => c.id === n.operation_case_id));
    call.notificationState = !linked?.length ? (cases === null ? 'unavailable' : 'not_applicable')
      : notices === null ? 'unavailable' : !notifications.length ? 'not_logged'
      : notifications.some(n => n.bounced_at || n.complained_at || n.provider_failed_at || ['failed', 'bounced', 'complained', 'delivery_delayed'].includes(n.status)) ? 'needs_attention'
      : notifications.some(n => n.delivered_at) ? 'delivered' : 'delivery_unconfirmed';
    // Caller ID never proves identity, a booking, callback permission, or consent.
    call.identityVerified = false;
    call.callbackConsent = null;
  }
}

export function createVoiceCallsHandler({ env = process.env, supabase = getSupabase, authorize = verifyOwner, now = Date.now } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
    const reference = req.method === 'POST' ? req.body?.reference : req.query?.reference;
    if (reference !== undefined && (typeof reference !== 'string' || !CALL_REF.test(reference))) return res.status(400).json({ error: 'Invalid call reference' });
    if (req.method === 'POST' && (!reference || req.body?.action !== 'review' || !/^[a-f0-9]{64}$/.test(req.body?.revision || '')))
      return res.status(400).json({ error: 'A call and its current revision are required' });
    let cursor;
    try { if (req.query?.cursor) cursor = decodeCursor(req.query.cursor); }
    catch { return res.status(400).json({ error: 'Invalid page cursor' }); }
    try {
      const sb = supabase();
      if (reference) {
        const { rows, complete } = await readCall(sb, reference);
        const call = projectVoiceCall(rows, null, complete);
        if (!call) return res.status(404).json({ error: 'Call not found' });
        if (req.method === 'POST') {
          if (!complete || req.body.revision !== call.revision) return res.status(409).json({ error: 'Call activity changed or is incomplete. Refresh before marking reviewed.' });
          const { error } = await sb.from('activity_logs').upsert({ id: voiceRowId('review:' + reference), booking_id: null,
            event_type: VOICE_REVIEW, actor_type: 'owner', actor_name: 'Owner', description: 'Phone call activity reviewed',
            metadata: { version: 1, callReference: reference, revision: call.revision }, created_at: new Date(now()).toISOString() }, { onConflict: 'id' });
          if (error) throw new Error('Review save unavailable');
          return res.status(200).json({ reviewed: true });
        }
        await enrich(sb, [call]);
        return res.status(200).json({ call });
      }
      const since = new Date(now() - 30 * 86400000).toISOString();
      let query = events(sb).gte('created_at', since).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE_SIZE + 1);
      if (cursor) query = query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
      const page = await result(query);
      const hasMore = page.length > PAGE_SIZE;
      const selected = page.slice(0, PAGE_SIZE);
      const references = [...new Set(selected.map(r => r.metadata?.callReference).filter(r => CALL_REF.test(r || '')))];
      const calls = [];
      // Bound URL size and response size. A full batch is explicitly partial, not
      // presented as an authoritative call outcome. Detail uses its own query.
      for (let offset = 0; offset < references.length; offset += 20) {
        const batch = references.slice(offset, offset + 20);
        const hydrated = await result(events(sb).in('metadata->>callReference', batch)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(501));
        const complete = hydrated.length <= 500;
        for (const ref of batch) {
          const ownRows = hydrated.slice(0, 500).filter(r => r.metadata.callReference === ref);
          const call = projectVoiceCall(ownRows.length ? ownRows : selected.filter(r => r.metadata.callReference === ref), null, complete && ownRows.length > 0);
          if (call) calls.push(call);
        }
      }
      await enrich(sb, calls);
      calls.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      const enabled = voiceConfig(env).enabled;
      return res.status(200).json({ enabled, days: 30, calls,
        nextCursor: hasMore ? encodeCursor(selected.at(-1)) : null,
        unreviewed: calls.filter(c => c.reviewState === 'unreviewed').length,
        reviewStateAvailable: calls.every(c => c.reviewState !== 'unavailable'),
        scope: 'Configured provider feeds only. Public forwarding and transfer coverage require live verification. Separate call legs are shown separately.',
        warning: enabled ? 'Feed configured; delivery and route coverage must be tested. Call history does not authorize contact.'
          : 'Live call capture is not enabled here. Existing history, if any, remains available. This is not proof that no one called.',
      });
    } catch { return res.status(503).json({ error: 'Phone call history is unavailable. Do not interpret this as no calls.' }); }
  };
}

export default createVoiceCallsHandler();
