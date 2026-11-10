#!/usr/bin/env node
// Serves the repository as the site, for the browser tests in tests/e2e.
// Static files only: every /api/* call is answered by the test itself with
// fixed test data (page.route), so a test never reaches production.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.E2E_PORT || 4310);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

async function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^([/\\])+/, '');
  if (clean.split(/[/\\]/).includes('..')) return null;
  for (const candidate of [clean, `${clean}.html`, join(clean, 'index.html')]) {
    const full = join(root, candidate);
    try { if ((await stat(full)).isFile()) return full; } catch { /* next */ }
  }
  return null;
}

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not answered by the test' }));
    return;
  }
  const file = await resolveFile(req.url === '/' ? '/index.html' : req.url);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
}).listen(port, '127.0.0.1', () => console.log(`e2e static server on http://127.0.0.1:${port}`));
