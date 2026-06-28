import { getSupabase } from '../_supabase.js';
import {
  buildRequestId,
  getDeploymentMetadata,
  hashIdentifier,
  insertOperationalEventFailOpen,
  redactString,
} from '../_observability.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString('utf8')); } catch (e) { return {}; }
  }
  return typeof req.body === 'object' ? req.body : {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseBody(req);
  const requestId = String(body.clientEventId || buildRequestId(req.headers || {})).slice(0, 128);
  const pagePath = String(body.pagePath || req.headers.referer || '/').slice(0, 240);
  const pageHref = String(body.pageHref || req.headers.referer || '').slice(0, 500);
  const sessionId = String(body.sessionId || '').trim();
  const source = String(body.source || '').slice(0, 240);
  const line = Number(body.line) || 0;
  const column = Number(body.column) || 0;
  const message = redactString(body.message || 'Unknown client runtime error') || 'Unknown client runtime error';
  const stack = redactString(body.stack || '');
  const kind = String(body.kind || 'window_error').slice(0, 64);
  const sb = getSupabase();

  await insertOperationalEventFailOpen(sb, {
    request_id: requestId,
    event_type: 'runtime_error',
    route: pagePath || '/',
    method: 'CLIENT',
    actor_role: 'anonymous',
    actor_id_hash: hashIdentifier(sessionId, { prefix: 'sess', length: 16 }),
    stage: kind,
    status_code: 0,
    reason_code: 'runtime_exception',
    reason_detail: message,
    mutation_result: 'error_observed',
    payload: {
      pageHref,
      source,
      line,
      column,
      stack,
      userAgent: body.userAgent || '',
      viewport: body.viewport || null,
    },
    ...getDeploymentMetadata(),
  });

  return res.status(202).json({ ok: true });
}
