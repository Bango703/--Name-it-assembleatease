// Local-only visual fixture. Never loads credentials or accesses a provider.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { projectVoiceCall, VOICE_EVENT, voiceRowId } from '../api/_voice-call-history.js';
import { intakeCallReference } from '../api/_ai-intake-validation.js';

const root = new URL('../', import.meta.url);
const page = await readFile(new URL('owner/index.html', root), 'utf8');
const fragment = page.slice(page.indexOf('<div id="voice-calls-view"'), page.indexOf('<div id="cases-view"'))
  .replace('style="display:none"', '');
const date = new Date();
const calls = [0, 1, 2].map(index => {
  const reference = intakeCallReference({ callControlId: 'v3:local_visual_fixture_' + index });
  const event = (status, seconds) => ({ id: voiceRowId('fixture:' + index + status), event_type: VOICE_EVENT,
    created_at: new Date(date - (index * 3600000) - seconds * 1000).toISOString(),
    metadata: { callReference: reference, status, source: 'texml', occurredAt: new Date(date - (index * 3600000) - seconds * 1000).toISOString(),
      from: '+15125550100', to: '+15125550101', direction: 'inbound' } });
  const call = projectVoiceCall(index === 2 ? [event('initiated', 60)] : index === 1 ? [event('initiated', 60), event('no-answer', 0)] : [event('initiated', 60), event('in-progress', 50), event('completed', 0)]);
  return { ...call, requestState: index === 0 ? 'saved' : 'none_found', notificationState: index === 0 ? 'delivered' : 'not_applicable',
    reviewState: 'unreviewed', cases: index === 0 ? [{ id: '11111111-1111-4111-8111-111111111111', ref: 'AAE-AI-FIXTURE', subject: 'Fictional customer: outdoor assembly request', status: 'open', severity: 'normal' }] : [] };
});
const fixture = () => ({ enabled: true, calls, nextCursor: null, unreviewed: calls.filter(c => !c.reviewed).length, reviewStateAvailable: true,
  warning: 'LOCAL VISUAL TEST: Fictional records only. Live call capture is not enabled by this preview.',
  scope: 'Call records remain separate from confirmed Cases. No live accounts are contacted.' });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/owner/voice-calls') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); const call = calls.find(c => c.reference === input.reference);
        if (call) { call.reviewed = true; call.reviewState = 'reviewed'; }
        return res.end(JSON.stringify({ reviewed: true }));
      }
      const reference = url.searchParams.get('reference');
      return res.end(JSON.stringify(reference ? { call: calls.find(c => c.reference === reference) } : fixture()));
    }
    if (['/owner/assets/voice-calls.css', '/owner/assets/voice-calls.js'].includes(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      return res.end(await readFile(new URL(url.pathname.slice(1), root)));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone Calls - Local Visual Test</title><link rel="stylesheet" href="/owner/assets/voice-calls.css"><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:#f8fafc;color:#0f172a;font:14px Arial,sans-serif}h2,h3,dl,dd{margin:0}:root{--muted:#64748b;--border:#e2e8f0}@media(max-width:500px){body{padding:16px}}</style></head><body>' + fragment + '<script>window._ownerHeaders=function(){return {Authorization:"Bearer fictional-preview"}};</script><script src="/owner/assets/voice-calls.js"></script><script>window.OwnerVoiceCalls.load();</script></body></html>');
  } catch { res.statusCode = 500; res.end('Local fixture unavailable'); }
});
server.listen(4196, '127.0.0.1', () => console.log('Fictional Phone Calls preview: http://127.0.0.1:4196'));
