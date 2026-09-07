import assert from 'node:assert/strict';
import { buildSoraSaveGuard, SAVE_GUARD } from './lib/sora-save-guard.mjs';

const fixture = {
  instructions: 'Preserve customer/Easer safety. Route to the correct customer or service-pro node to save; the entry node cannot save.',
  voice_settings: { voice: 'unchanged-voice' }, model: 'unchanged-model',
  tools: [
    { tool_id: 'save-existing', webhook: { name: 'save_support_request', url: 'https://www.assembleatease.com/api/ai/support', preset_body_fields: { action: 'submit_request', callControlId: '{{call_control_id}}' } } },
    { tool_id: 'options-existing', webhook: { name: 'get_support_options' } },
  ],
  conversation_flow: {
    start_node_id: 'sora_receptionist',
    nodes: ['sora_receptionist', 'sora_customer', 'sora_service_pro'].map((id, i) => ({
      id, type: 'prompt', instructions: i ? 'Preserve role instructions.' : 'Do not save here; transition to the appropriate role path.',
      instructions_mode: 'append', tools_mode: 'replace',
      shared_tool_ids: i ? ['options-existing', 'save-existing'] : ['options-existing'],
      tools: [{ responseOnly: true }], position: { x: i * 100, y: 10 },
    })),
    edges: [{ id: 'unchanged-role-edge', start_node_id: 'sora_receptionist', target: { type: 'node', node_id: 'sora_customer' }, condition: { type: 'llm', prompt: 'Customer intent' } }],
  },
};
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const original = structuredClone(fixture);
const patch = buildSoraSaveGuard(fixture);
check(JSON.stringify(fixture) === JSON.stringify(original), 'Read snapshot is not mutated');
check(patch.promote_to_main === false, 'Draft must not silently become live');
check(Object.keys(patch).sort().join(',') === 'conversation_flow,instructions,promote_to_main,version_name', 'No voice, routing, tool credentials, money or privacy change');
check(JSON.stringify(patch.conversation_flow.edges) === JSON.stringify(fixture.conversation_flow.edges), 'Role-routing edges unchanged');
check(patch.conversation_flow.start_node_id === fixture.conversation_flow.start_node_id, 'Same receptionist entry');
for (const node of patch.conversation_flow.nodes) {
  check(node.shared_tool_ids.includes('save-existing'), 'Confirmed intake can save even without node transition');
  check(node.shared_tool_ids.includes('options-existing'), 'Capability check preserved');
  check(new Set(node.shared_tool_ids).size === node.shared_tool_ids.length, 'No duplicate tools');
  check(node.instructions.includes(SAVE_GUARD), 'Every active node has execution/receipt guard');
  check(!node.instructions.includes('Do not save here'), 'No contradictory save prohibition');
  check(!Object.hasOwn(node, 'tools'), 'No stale response-only tool copy submitted');
  check(node.instructions_mode === 'append' && node.tools_mode === 'replace', 'Role safety and tool scopes preserved');
}
check(patch.instructions.includes('Preserve customer/Easer safety.'), 'Existing global safety retained');
check(!patch.instructions.includes('entry node cannot save'), 'Global obsolete gate removed');
for (const phrase of ['actually call get_support_options', 'next action must be to call save_support_request',
  'success=true AND a nonempty ref', 'Never invent a reference', 'Do not save after a withdrawal', 'server validation remain mandatory'])
  check(patch.instructions.includes(phrase), phrase);
for (const modify of [
  c => { c.tools = []; }, c => { c.tools[0].webhook.url = 'https://example.com'; },
  c => { c.tools[0].webhook.preset_body_fields.callControlId = 'model-controlled'; },
  c => { c.conversation_flow.nodes.pop(); }, c => { c.conversation_flow.nodes[0].shared_tool_ids = []; },
  c => { c.instructions = SAVE_GUARD; },
]) { const bad = structuredClone(fixture); modify(bad); assert.throws(() => buildSoraSaveGuard(bad)); checks++; }
console.log(`PASS: ${checks} Sora save-guard configuration checks. No network or live changes.`);
