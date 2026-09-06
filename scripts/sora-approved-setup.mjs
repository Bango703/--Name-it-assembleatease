// Operator-only helper. Never imported by website/API code. No secret is logged
// or written to disk; the newly generated tool secret lives in this process
// until the approved deployment/test finishes, and in the two secret stores.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

if (!process.argv.includes('--approved-production-test-setup')) throw new Error('Explicit operator approval required');
const env = parseEnv(readFileSync('.env.local', 'utf8'));
if (!env.TELNYX_API_KEY) throw new Error('Missing local Telnyx key');
const assistant = 'assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84';
const version = '20260906T153456589927';
const base = `/ai/assistants/${assistant}`;
const endpoint = 'https://www.assembleatease.com/api/ai/receptionist';
const identifier = 'aae_sora_intake_20260906';
const secret = randomBytes(48).toString('base64url');
const report = value => console.log(JSON.stringify(value));
async function telnyx(path, method = 'GET', body) {
  const r = await fetch(`https://api.telnyx.com/v2${path}`, {
    method, headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000),
  });
  const raw = await r.json();
  if (!r.ok) throw new Error(`Telnyx ${method} ${path}: HTTP ${r.status}; codes ${(raw.errors || []).map(e => e.code).join(',')}`);
  return raw.data || raw;
}
function vercelEnv(name, value, sensitive) {
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `npx --no-install vercel env add ${name} production ${sensitive ? '--sensitive' : '--no-sensitive'} --yes`], {
    input: value, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  report({ environmentVariable: name, saved: r.status === 0 });
  if (r.status !== 0) throw new Error(`Could not save ${name}; existing values were not overwritten`);
}
const initialMain = await telnyx(base);
if (initialMain.version_id === version) throw new Error('Refuse to modify main version');
const draft = await telnyx(`${base}/versions/${version}`);
if (draft.telephony_settings?.recording_settings?.enabled !== false) throw new Error('Recording must be verified off first');
const existingSecrets = await telnyx('/integration_secrets');
if ((Array.isArray(existingSecrets) ? existingSecrets : []).some(s => s.identifier === identifier)) {
  throw new Error('Setup secret already exists; inspect prior setup, do not create/rotate blindly');
}
const createdSecret = await telnyx('/integration_secrets', 'POST', { identifier, type: 'bearer', token: secret });
report({ integrationSecretCreated: Boolean(createdSecret.id), identifier });
vercelEnv('TELNYX_AI_TOOL_SECRET', secret, true);
vercelEnv('TELNYX_AI_INTAKE_ENABLED', 'true', false);
vercelEnv('TELNYX_AI_CALLBACKS_ENABLED', 'true', false);

const services = ['Furniture Assembly', 'Mounting & Hanging', 'Smart Home', 'Outdoor & Playsets', 'Office Assembly', 'Fitness Equipment', 'Other'];
const string = description => ({ type: 'string', description });
function webhook(name, description, properties, required, preset) {
  return { type: 'webhook', webhook: {
    name, description, url: endpoint, method: 'POST', async: false, timeout_ms: 10000,
    headers: [
      { name: 'Authorization', value: `Bearer {{#integration_secret}}${identifier}{{/integration_secret}}` },
      { name: 'Content-Type', value: 'application/json' },
    ],
    body_parameters: { type: 'object', properties, required }, preset_body_fields: preset,
  } };
}
const tools = [
  webhook('get_service_catalog', 'Get current AssembleAtEase service categories and secure booking links; no pricing or reservations.', {}, [], { action: 'catalog' }),
  webhook('get_service_items', 'Get the current items for one exact service category from the website catalog.', {
    service: { type: 'string', enum: services },
  }, ['service'], { action: 'catalog' }),
  webhook('request_callback', 'Save one callback request ONLY after the caller confirms all details and explicitly agrees to a callback. Not a booking, time reservation, payment or SMS.', {
    service: { type: 'string', enum: services }, name: string('Caller-confirmed name, maximum 120 characters.'),
    phone: string('Caller-confirmed US callback number; no extensions.'), city: string('City, maximum 100 characters.'),
    project: string('Concise confirmed project summary, 10-1500 characters. No payment details, street address or access codes.'),
    preferredTime: string('Requested callback time, not confirmed; use Not specified if none.'),
    detailsConfirmed: { type: 'boolean', description: 'True only after the caller confirms the read-back details.' },
    callbackConsent: { type: 'boolean', description: 'True only after explicit permission for a callback about this request.' },
  }, ['service', 'name', 'phone', 'city', 'project', 'preferredTime', 'detailsConfirmed', 'callbackConsent'], {
    action: 'request_callback', callControlId: '{{call_control_id}}',
  }),
];
const keepIds = draft.tools.map(t => t.tool_id);
if (keepIds.some(id => !id) || keepIds.length !== 2) throw new Error('Existing tool set changed; review before attachment');
await telnyx(`${base}/versions/${version}`, 'POST', {
  tools, tool_ids: keepIds,
  instructions: readFileSync('business-artifacts/telnyx-sora-receptionist-prompt-2026-09-06.txt', 'utf8'),
});
const saved = await telnyx(`${base}/versions/${version}`);
report({ draft: saved.version_id, tools: saved.tools.map(t => ({ id: t.tool_id, type: t.type, name: t.webhook?.name || t.name })),
  recordingEnabled: saved.telephony_settings?.recording_settings?.enabled,
  mainUnchanged: (await telnyx(base)).version_id === initialMain.version_id });
report({ readyForCommands: ['catalog', 'callback', 'tool-catalog', 'tool-callback', 'exit'], automaticPhoneCalls: false });
const testInput = {
  action: 'request_callback', callControlId: 'v3:aae_approved_test_20260906_01',
  service: 'Furniture Assembly', name: 'TEST - Sora integration', phone: '+17372906129', city: 'Austin',
  project: 'TEST ONLY - approved Sora integration check for one bed assembly. Do not dispatch, book, charge, or contact a customer.',
  preferredTime: 'TEST ONLY - no appointment requested', detailsConfirmed: true, callbackConsent: true,
};
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const command = line.trim();
  try {
    if (command === 'exit') break;
    if (command === 'catalog' || command === 'callback') {
      const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command === 'catalog' ? { action: 'catalog' } : testInput), signal: AbortSignal.timeout(30000) });
      const result = await r.json();
      report({ command, httpStatus: r.status, result });
    } else if (command === 'tool-catalog' || command === 'tool-callback') {
      const toolName = command === 'tool-catalog' ? 'get_service_catalog' : 'request_callback';
      const tool = saved.tools.find(t => t.webhook?.name === toolName || t.name === toolName);
      if (!tool?.tool_id) throw new Error('Missing saved tool ID');
      const { action: _action, callControlId: _callControlId, ...args } = testInput;
      const r = await telnyx(`${base}/tools/${tool.tool_id}/test`, 'POST', {
        arguments: command === 'tool-catalog' ? {} : args,
        dynamic_variables: { call_control_id: testInput.callControlId },
      });
      report({ command, success: r.success, status: r.status_code, response: r.response });
    } else report({ ignoredCommand: true });
  } catch (e) { report({ command, error: String(e.message).replaceAll(secret, '[REDACTED]').replaceAll(env.TELNYX_API_KEY, '[REDACTED]') }); }
}
rl.close();
