#!/usr/bin/env node
// The AI assistant connector, driven by the official MCP client library
// (@modelcontextprotocol/sdk, the TypeScript SDK the MCP project publishes) over
// real HTTP. scripts/test-mcp-server.mjs checks the handler message by message;
// this proves a real client can connect, negotiate, list the tools, call every
// one and end its session against the same handler Vercel serves.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from '../api/mcp.js';

const usage = [];
const seen = [];
const handler = createMcpHandler({
  rateLimiter: async () => true,
  recordToolCall: async (row) => { usage.push(row); },
});

// What Vercel hands a function: req.body parsed from JSON, res.status().json().
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let body = text;
    if (/json/.test(req.headers['content-type'] || '')) { try { body = JSON.parse(text); } catch { body = text; } }
    seen.push({ method: req.method, session: req.headers['mcp-session-id'] || null, version: req.headers['mcp-protocol-version'] || null, accept: req.headers.accept || '' });
    const vres = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(code) { res.statusCode = code; return this; },
      json(value) { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return this; },
      end() { res.end(); return this; },
    };
    if (new URL(req.url, 'http://x').pathname !== '/api/mcp') { res.statusCode = 404; return res.end(); }
    await handler(Object.assign(req, { body }), vres);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = new URL(`http://127.0.0.1:${server.address().port}/api/mcp`);

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}`); console.error(error); process.exitCode = 1; }
}

try {
  await check('the SDK speaks a protocol version the server supports', () => {
    assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(LATEST_PROTOCOL_VERSION), `SDK ${LATEST_PROTOCOL_VERSION} not in ${SUPPORTED_PROTOCOL_VERSIONS}`);
  });

  const client = new Client({ name: 'claude-ai', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url);

  await check('a client connects and the session carries the assistant', async () => {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'assembleatease');
    assert.equal(client.getServerVersion().title, 'AssembleAtEase');
    assert.match(client.getInstructions() || '', /do not create bookings or take payment/);
    assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });
    assert.match(transport.sessionId || '', /^claude\.[0-9a-f-]{36}$/);
  });

  let tools = [];
  await check('tools/list returns the six read-only tools', async () => {
    ({ tools } = await client.listTools());
    assert.equal(tools.length, 6);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.ok(t.title, t.name);
    }
  });

  const calls = {
    list_services: {},
    search_services: { query: 'treadmill' },
    estimate_price: { items: [{ service: 'Furniture Assembly', item: 'Bed frame — queen', quantity: 1 }, { service: 'Mounting & Hanging', item: 'TV 41"–55" (standard wall)' }] },
    get_appointment_times: {},
    get_service_area: {},
    get_booking_policies: {},
  };
  await check('every tool answers through the client with structured content', async () => {
    for (const t of tools) {
      const result = await client.callTool({ name: t.name, arguments: calls[t.name] });
      assert.notEqual(result.isError, true, `${t.name}: ${result.content?.[0]?.text}`);
      assert.ok(result.structuredContent && typeof result.structuredContent === 'object', t.name);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${t.name} text block is the same JSON`);
    }
  });

  await check('booking links from this session are tagged claude', async () => {
    const result = await client.callTool({ name: 'estimate_price', arguments: calls.estimate_price });
    const link = new URL(result.structuredContent.bookingUrl);
    assert.equal(link.searchParams.get('utm_source'), 'claude');
    assert.equal(link.searchParams.getAll('add').length, 2);
  });

  await check('a bad argument comes back as a tool error the model can read', async () => {
    const result = await client.callTool({ name: 'estimate_price', arguments: { items: [{ service: 'Furniture Assembly', item: 'flux capacitor' }] } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /is not in Furniture Assembly/);
  });

  await check('an unknown tool is a protocol error', async () => {
    await assert.rejects(() => client.callTool({ name: 'create_booking', arguments: {} }), /Unknown tool/);
  });

  await check('ping works and every later request carried the session and the version', async () => {
    await client.ping();
    const after = seen.slice(1).filter((r) => r.method === 'POST');
    assert.ok(after.length >= 8);
    for (const r of after) {
      assert.match(r.session || '', /^claude\./);
      assert.equal(r.version, LATEST_PROTOCOL_VERSION);
      assert.match(r.accept, /application\/json/);
      assert.match(r.accept, /text\/event-stream/);
    }
  });

  await check('the client can end its session and close cleanly', async () => {
    await transport.terminateSession();
    await client.close();
    assert.ok(seen.some((r) => r.method === 'DELETE'), 'DELETE was sent');
  });

  await check('a client asking for an older protocol is served it', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1' } } }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.protocolVersion, '2025-03-26');
    assert.match(res.headers.get('mcp-session-id'), /^chatgpt\./);
  });

  await check('usage was counted once per tool call, with no arguments', () => {
    assert.equal(usage.length, 8, "6 tools, the tagged estimate and the bad argument; the unknown tool is not a tool call");
    assert.doesNotMatch(JSON.stringify(usage), /treadmill|flux|Bed frame/);
  });
} finally {
  server.close();
}

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}.`);
