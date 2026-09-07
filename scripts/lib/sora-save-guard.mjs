// Operator-only configuration transform. No network, secrets, or live writes.
// Keep caller-role/consent validation on the server; do not depend on an LLM
// workflow transition to make the confirmed-intake tool available.
export const SAVE_GUARD = `CONFIRMED REQUEST SAVE — REQUIRED EXECUTION
The customer and service-pro paths describe different interviews, not a requirement to change workflow nodes before saving. If the active node stays on reception, continue the correct role interview there. The save_support_request tool is available in every prompt node.
Before detailed intake, actually call get_support_options and inspect its result. Do not merely say you checked. If requestsEnabled is not true, explain that saving is unavailable and offer the contact page; do not collect a full request or promise a callback.
Read back the relevant details and callback number, then ask exactly: Are those details correct, and may our team call you about this request? END YOUR TURN AND WAIT. Only a separate real user message can be the caller's confirmation. Never write or speak a caller reply yourself, including simulated phrases such as Caller confirmed: Yes. Do not call the save tool in the same turn as asking for confirmation. If the caller corrects anything, read back the correction and wait for a new yes.
After the caller confirms the factual readback and explicitly permits a callback, your next action must be to call save_support_request with those confirmed facts. Do not respond with a success sentence instead of executing the tool. Do not speak the tool name.
Follow the declared tool schema exactly: city is a top-level field, NEVER a bookingDetails field. bookingDetails is only for a customer's new_service/custom_quote request; omit it for Easer support. If a 400 reports field placement, correct that placement using the same confirmed facts and retry once without discarding details. Reconfirm only if the facts themselves change.
A request is saved ONLY when that tool returns success=true AND a nonempty ref for this call. Without both, you have no saved request. Never invent a reference, pretend to execute a tool, or say saved, submitted, sent, all set, or the team will follow up. A transcript or collected details are not a saved request.
On confirmed success, tell the caller the request is saved and give the returned reference if wanted. On failure, follow the existing bounded retry rules; if still unsuccessful, plainly say you could not save it and offer assembleatease.com/contact. Keep appointments, payments, account changes, owner acknowledgment and delivery separate from request receipt.
Do not save after a withdrawal, invent consent, or create a second request. The existing one-call idempotency and server validation remain mandatory.`;

export function buildSoraSaveGuard(config) {
  const save = config?.tools?.find(t => t.webhook?.name === 'save_support_request');
  const options = config?.tools?.find(t => t.webhook?.name === 'get_support_options');
  if (!save?.tool_id || !options?.tool_id) throw new Error('Existing shared save/options tools are required');
  if (save.webhook.url !== 'https://www.assembleatease.com/api/ai/support'
      || save.webhook.preset_body_fields?.action !== 'submit_request'
      || save.webhook.preset_body_fields?.callControlId !== '{{call_control_id}}')
    throw new Error('Save endpoint or provider-controlled identity changed');
  const flow = structuredClone(config.conversation_flow);
  if (flow?.start_node_id !== 'sora_receptionist' || flow.nodes?.length !== 3
      || !['sora_receptionist', 'sora_customer', 'sora_service_pro'].every(id => flow.nodes.some(n => n.id === id)))
    throw new Error('Unexpected live role workflow');
  if (typeof config.instructions !== 'string' || config.instructions.includes(SAVE_GUARD))
    throw new Error('Missing instructions or guard already applied');
  const stripObsoleteGate = text => text
    .replace('Do not save here; transition to the appropriate role path.', 'Identify the caller role and continue its interview, even if the workflow node does not change.')
    .replace('Route to the correct customer or service-pro node to save; the entry node cannot save.', 'Use the correct caller role; saving does not require a workflow-node transition.');
  for (const node of flow.nodes) {
    if (node.type !== 'prompt' || !Array.isArray(node.shared_tool_ids) || node.tools_mode !== 'replace')
      throw new Error('Unexpected node tool scope');
    if (!node.shared_tool_ids.includes(options.tool_id)) throw new Error('Node is missing capability check');
    if (!node.shared_tool_ids.includes(save.tool_id)) node.shared_tool_ids.push(save.tool_id);
    node.instructions = stripObsoleteGate(node.instructions) + '\n\n' + SAVE_GUARD;
    // tools is the response-only expanded copy. Send the authoritative shared IDs.
    delete node.tools;
  }
  return {
    version_name: 'Save guard - confirmed customer and Easer intake',
    promote_to_main: false,
    instructions: SAVE_GUARD + '\n\n' + stripObsoleteGate(config.instructions),
    conversation_flow: flow,
  };
}
