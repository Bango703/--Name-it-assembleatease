import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The Easer notification bell, exercised for real.
//
// assets/js/easer-notifications.js was referenced by both Easer pages from
// 2026-08-26 but never committed to main, so production served a 404 and the
// bell opened an empty panel with no unread count. Restoring it also fixed an
// Article 16 defect it carried: it zeroed the badge BEFORE the mark-read write,
// so a failed request showed "all caught up" while the server still held the
// notifications unread. This test runs the shipped script against a minimal
// DOM and a scripted API to prove the badge only moves on server truth, and
// that loaded rows drop the pages' centered "Loading..." styling.

function element(id) {
  const el = {
    id,
    children: [],
    className: '',
    style: {},
    attributes: {},
    listeners: {},
    href: '',
    dateTime: '',
    type: '',
    _text: '',
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value); this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
  return el;
}

function installPage() {
  const nodes = {
    'eh-bell-btn': element('eh-bell-btn'),
    'notif-list': element('notif-list'),
    'eh-bell-badge': element('eh-bell-badge'),
    'notif-panel': element('notif-panel'),
  };
  nodes['notif-panel'].style.display = 'none';
  // Every page ships the list with this inline "Loading..." styling.
  nodes['notif-list'].attributes.style = 'text-align:center;padding:1.5rem 0;color:var(--e-muted);font-size:0.875rem';
  const docListeners = {};
  globalThis.document = {
    getElementById: id => nodes[id] || null,
    createElement: tag => element(tag),
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
  };
  globalThis.window = {
    supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  return { nodes, fire: type => Promise.all((docListeners[type] || []).map(fn => fn())) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function settle() { for (let i = 0; i < 10; i += 1) await tick(); }

const unreadItems = [
  { id: 'n1', title: 'New job', detail: 'Outdoor & Playsets', createdAt: new Date().toISOString(), read: false, href: '/assembler/my-assignments?job=bk1' },
  { id: 'n2', title: 'Job update', detail: 'Schedule changed', createdAt: new Date().toISOString(), read: false, href: '/assembler/my-assignments?job=bk2' },
];

let load = 0;
async function importFresh() {
  load += 1;
  await import(new URL(`../assets/js/easer-notifications.js?case=${load}`, import.meta.url));
}

// ── 1. Opening the page shows the server's unread count ─────────────────────
{
  const page = installPage();
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(opts.method || 'GET');
    return { ok: true, json: async () => ({ notifications: unreadItems, unreadCount: 2 }) };
  };
  await importFresh();
  await page.fire('DOMContentLoaded');
  await settle();
  assert.equal(page.nodes['eh-bell-badge'].textContent, '2', 'the badge shows the unread count on load');
  assert.equal(page.nodes['eh-bell-badge'].style.display, '', 'and is visible');
  assert.equal(page.nodes['notif-list'].children.length, 2, 'both notifications render');
  assert.equal(page.nodes['notif-list'].children[0].href, '/assembler/my-assignments?job=bk1',
    'each notification opens its job');
  assert.equal(page.nodes['notif-list'].attributes.style, undefined,
    'the centered, padded placeholder styling is dropped once rows load');
  assert.equal(page.nodes['notif-list'].className, 'easer-notification-list');
  assert.deepEqual(calls, ['GET']);
}

// ── 2. The badge clears only after the server confirms the write ───────────
{
  const page = installPage();
  let serverRead = false;
  let releasePost;
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(method);
    if (method === 'POST') {
      assert.deepEqual(JSON.parse(opts.body), { ids: ['n1', 'n2'] }, 'every visible unread id is sent');
      await postGate;
      serverRead = true;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return {
      ok: true,
      json: async () => serverRead
        ? { notifications: unreadItems.map(i => ({ ...i, read: true })), unreadCount: 0 }
        : { notifications: unreadItems, unreadCount: 2 },
    };
  };
  await importFresh();
  await page.fire('DOMContentLoaded');
  await settle();

  page.nodes['notif-panel'].style.display = 'block';
  page.nodes['eh-bell-btn'].listeners.click.forEach(fn => fn());
  await settle();

  assert.ok(calls.includes('POST'), 'opening the panel sends the mark-read write');
  assert.equal(page.nodes['eh-bell-badge'].textContent, '2',
    'Article 16: while the write is in flight the badge must still show the server count');

  releasePost();
  await settle();
  assert.equal(page.nodes['eh-bell-badge'].style.display, 'none', 'after a confirmed write the badge clears');
  assert.deepEqual(calls.slice(-1), ['GET'], 'and it clears from a fresh read of server truth');
}

// ── 3. A failed write leaves everything showing as unread ──────────────────
{
  const page = installPage();
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST') return { ok: false, json: async () => ({ error: 'boom' }) };
    return { ok: true, json: async () => ({ notifications: unreadItems, unreadCount: 2 }) };
  };
  await importFresh();
  await page.fire('DOMContentLoaded');
  await settle();
  page.nodes['notif-panel'].style.display = 'block';
  page.nodes['eh-bell-btn'].listeners.click.forEach(fn => fn());
  await settle();
  assert.equal(page.nodes['eh-bell-badge'].textContent, '2', 'a failed write must not look like a success');
  assert.equal(page.nodes['eh-bell-badge'].style.display, '');
  assert.match(page.nodes['notif-list'].children[0].className, /is-unread/, 'items stay marked unread');
}

// ── 4. A failed load offers a retry, laid out by the list's own styles ─────
{
  const page = installPage();
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'unavailable' }) });
  await importFresh();
  await page.fire('DOMContentLoaded');
  await settle();
  const list = page.nodes['notif-list'];
  assert.equal(list.children.length, 1, 'a failed load shows a single retry control');
  assert.equal(list.children[0].className, 'easer-notification-retry');
  assert.equal(list.children[0].textContent, 'Notifications unavailable. Tap to retry.');
  assert.equal(list.attributes.style, undefined, 'the placeholder styling is dropped on failure too');
}

// ── 5. Every Easer page with the bell loads it, and it exists ──────────────
for (const rel of ['assembler/index.html', 'assembler/my-assignments.html', 'assembler/payouts.html', 'assembler/profile.html']) {
  const html = await readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
  assert.match(html, /<script src="\.\.\/assets\/js\/easer-notifications\.js/, `${rel} must load the bell script`);
}
await readFile(new URL('../assets/js/easer-notifications.js', import.meta.url), 'utf8');

console.log('Easer notification bell tests: PASS');
