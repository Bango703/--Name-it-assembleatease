import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

// UI-only test surface. Never serves .env, APIs, repository metadata, customer
// records or financial credentials. CSP blocks backend calls and payment forms.
const root = resolve(import.meta.dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'");
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const allowed = path === '/book' || path === '/book.html' || /^\/(assets|images)\/[a-zA-Z0-9_./ -]+$/.test(path);
    if (req.method !== 'GET' || !allowed) { res.writeHead(404).end('Not available in UI-only preview'); return; }
    const file = resolve(root, (path === '/book' ? '/book.html' : path).slice(1));
    if (!file.startsWith(root + sep) || !mime[extname(file)]) { res.writeHead(404).end(); return; }
    const data = await readFile(file);
    res.setHeader('Content-Type', mime[extname(file)] + (['.html', '.js', '.css'].includes(extname(file)) ? '; charset=utf-8' : ''));
    res.end(data);
  } catch { res.writeHead(404).end('Not available'); }
}).listen(4179, '127.0.0.1', () => console.log('UI-only Sora preview: http://127.0.0.1:4179/book (no backend/payment access)'));
