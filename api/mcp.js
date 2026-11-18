// POST /api/mcp: the AI assistant connector (Model Context Protocol).
//
// Claude, ChatGPT and other assistants add this URL as a connector and call
// the read-only tools in api/_mcp-tools.js: services, prices, appointment
// times, where we work and the booking terms. Customers then book and pay on
// assembleatease.com through the links those tools return.
//
// Streamable HTTP transport, stateless: every POST carries one JSON-RPC message
// (or a batch) and gets one JSON response. No server-sent event stream, so GET
// answers 405 as the specification allows. The session ID handed out at
// initialize stores nothing; it only carries which assistant connected
// (claude.<uuid>), so the booking links of later calls can say where the
// customer came from.
// Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
//
// Public and unauthenticated on purpose: it answers only what the public
// website already shows. It writes nothing but one usage row per tool call
// (tool name, assistant, outcome; no arguments, no IP address).

import { randomUUID } from 'node:crypto';
import { rateLimit } from './_ratelimit.js';
import { getSupabase } from './_supabase.js';
import { getDeploymentMetadata, recordOperationalEvents } from './_observability.js';
import { ASSISTANT_SOURCES, SITE, callTool, hasTool, toolDefinitions } from './_mcp-tools.js';

const DEFAULT_TOOLS = Object.freeze({ callTool, hasTool, toolDefinitions });

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

export const SERVER_VERSION = '1.0.0';
// Newest first. A client asking for one of these gets it back; any other
// request gets the newest, and the client decides whether to continue.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_BATCH = 20;

// Browsers send Origin; assistants calling from their servers usually do not.
// The specification requires a 403 for an Origin we do not recognise, and
// Claude's connector guide names an over-strict Origin check as a common reason
// a connection times out, so every origin of the assistant companies (any
// subdomain) is accepted, and a refusal is logged ("mcp origin refused") so a
// new client origin shows in the logs the first day. Local origins stay open
// for the MCP Inspector and development.
const ALLOWED_ORIGIN_HOSTS = /^(?:(?:[a-z0-9-]+\.)*(?:assembleatease\.com|claude\.ai|claude\.com|anthropic\.com|chatgpt\.com|openai\.com|oaiusercontent\.com|gemini\.google\.com|perplexity\.ai|microsoft\.com))$/;
export function originAllowed(origin) {
  if (!origin) return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin !== origin) return false;
  if (url.protocol === 'https:' && ALLOWED_ORIGIN_HOSTS.test(url.hostname)) return true;
  return /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(origin);
}

export const SERVER_INFO = Object.freeze({
  name: 'assembleatease',
  title: 'AssembleAtEase',
  version: SERVER_VERSION,
  websiteUrl: SITE,
  icons: Object.freeze([
    Object.freeze({ src: `${SITE}/images/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] }),
  ]),
});

export const SERVER_INSTRUCTIONS = 'AssembleAtEase is a home-setup service in Texas: furniture assembly, TV and wall mounting, smart home installation, fitness equipment, outdoor and playset assembly, and office assembly. These tools read its live catalog, prices, appointment times, service area and booking terms. They do not create bookings or take payment; customers book and pay on www.assembleatease.com through the links the tools return.';

/** Which assistant this is, from its own name for itself. */
export function assistantFamily(name) {
  const text = String(name || '').toLowerCase();
  if (/claude|anthropic/.test(text)) return 'claude';
  if (/chatgpt|openai/.test(text)) return 'chatgpt';
  if (/gemini|google/.test(text)) return 'gemini';
  return 'ai_assistant';
}

const SESSION = /^(claude|chatgpt|gemini|ai_assistant)\.[0-9a-f-]{36}$/;
export function sessionFamily(sessionId) {
  const match = SESSION.exec(String(sessionId || ''));
  return match && ASSISTANT_SOURCES.includes(match[1]) ? match[1] : null;
}

function header(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(req) {
  const forwarded = String(header(req, 'x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || header(req, 'x-real-ip') || req.socket?.remoteAddress || 'unknown';
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function setCors(req, res) {
  const origin = header(req, 'origin');
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function parseBody(req) {
  // Vercel parses JSON bodies lazily and throws on malformed JSON when
  // req.body is read; that is a parse error for the client, not a crash.
  let body;
  try { body = req.body; } catch { return { ok: false }; }
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return { ok: true, value: body };
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
  if (!text.trim()) return { ok: false };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function negotiateVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

async function defaultRecordToolCall(row) {
  try {
    await recordOperationalEvents(getSupabase(), [row]);
  } catch (error) {
    console.warn('mcp usage row not recorded:', error?.message || error);
  }
}

export function createMcpHandler({
  tools = DEFAULT_TOOLS,
  rateLimiter = rateLimit,
  recordToolCall = defaultRecordToolCall,
  now = () => new Date(),
  newSessionId = randomUUID,
} = {}) {
  return async function handler(req, res) {
    setCors(req, res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!originAllowed(header(req, 'origin'))) {
      console.warn('mcp origin refused:', String(header(req, 'origin')).slice(0, 200));
      return res.status(403).json(rpcError(null, -32000, 'Origin not allowed.'));
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json(rpcError(null, -32000, 'This MCP endpoint takes JSON-RPC messages by POST and does not open an event stream.'));
    }

    const versionHeader = header(req, 'mcp-protocol-version');
    if (versionHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(versionHeader)) {
      return res.status(400).json(rpcError(null, -32000, `Unsupported MCP-Protocol-Version "${versionHeader}". Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`));
    }

    let allowed = true;
    try { allowed = await rateLimiter(clientIp(req), 'mcp'); } catch { allowed = true; }
    if (!allowed) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json(rpcError(null, -32000, 'Too many requests. Try again in a minute.'));
    }

    const parsed = parseBody(req);
    if (!parsed.ok) return res.status(400).json(rpcError(null, -32700, 'Parse error: the body must be one JSON-RPC message as JSON.'));
    const batch = Array.isArray(parsed.value);
    const messages = batch ? parsed.value : [parsed.value];
    if (batch && (!messages.length || messages.length > MAX_BATCH)) {
      return res.status(400).json(rpcError(null, -32600, `A batch must hold 1 to ${MAX_BATCH} messages.`));
    }

    let family = sessionFamily(header(req, 'mcp-session-id'))
      || assistantFamily(header(req, 'user-agent'));
    const responses = [];
    for (const message of messages) {
      const response = await handleMessage(message);
      if (response) responses.push(response);
    }
    if (!responses.length) return res.status(202).end();
    return res.status(200).json(batch ? responses : responses[0]);

    async function handleMessage(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
        return rpcError(message?.id ?? null, -32600, 'Invalid request: expected a JSON-RPC 2.0 message.');
      }
      const isRequest = typeof message.method === 'string' && Object.prototype.hasOwnProperty.call(message, 'id');
      const isNotification = typeof message.method === 'string' && !isRequest;
      const isResponse = !message.method && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
      // Notifications (initialized, cancelled, ...) and replies need no answer.
      if (isNotification || isResponse) return null;
      if (!isRequest) return rpcError(message.id ?? null, -32600, 'Invalid request: no method.');
      const { id } = message;
      if (id === null || !['string', 'number'].includes(typeof id)) return rpcError(null, -32600, 'Invalid request: id must be a string or a number.');
      const params = message.params === undefined ? {} : message.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) return rpcError(id, -32602, 'Invalid params: params must be an object.');

      switch (message.method) {
        case 'initialize': {
          const clientName = [params.clientInfo?.name, params.clientInfo?.title].filter(Boolean).join(' ');
          family = assistantFamily(clientName) !== 'ai_assistant' ? assistantFamily(clientName) : family;
          res.setHeader('Mcp-Session-Id', `${family}.${newSessionId()}`);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: negotiateVersion(params.protocolVersion),
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: SERVER_INSTRUCTIONS,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: tools.toolDefinitions() } };
        case 'tools/call': {
          const name = params.name;
          if (typeof name !== 'string' || !tools.hasTool(name)) {
            return rpcError(id, -32602, `Unknown tool: ${typeof name === 'string' ? name : '(none)'}. Tools: ${tools.toolDefinitions().map((t) => t.name).join(', ')}.`);
          }
          let result;
          try {
            result = tools.callTool(name, params.arguments, { source: family, now: now() });
          } catch (error) {
            console.error('mcp tool failed:', name, error?.message || error);
            await recordToolCall(usageRow({ tool: name, family, outcome: 'server_error', status: 500 }));
            return rpcError(id, -32603, `The ${name} tool could not answer just now. Try again, or see ${SITE}/book.`);
          }
          await recordToolCall(usageRow({ tool: name, family, outcome: result.isError ? 'invalid_arguments' : 'answered', status: result.isError ? 400 : 200 }));
          return { jsonrpc: '2.0', id, result };
        }
        default:
          return rpcError(id, -32601, `Method not found: ${message.method}.`);
      }
    }
  };
}

function usageRow({ tool, family, outcome, status }) {
  return {
    event_type: 'ai_assistant_tool_call',
    route: '/api/mcp',
    method: 'POST',
    actor_role: 'anonymous',
    stage: tool,
    status_code: status,
    reason_code: status === 400 ? 'invalid_input' : status >= 500 ? 'runtime_exception' : null,
    mutation_result: 'none',
    payload: { assistant: family, outcome },
    ...getDeploymentMetadata(),
  };
}

export default createMcpHandler();
