import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('assets/js/native-app.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function run(path, role = null, options = {}) {
  const nodes = new Map(), listeners = {}, events = {}, calls = [], storage = new Map();
  const element = () => ({
    hidden: false, children: [], setAttribute() {}, addEventListener(type, fn) { this[type] = fn; },
    append(...children) { this.children.push(...children); children.forEach(n => n.id && nodes.set(n.id, n)); },
  });
  const document = {
    readyState: 'complete',
    head: { appendChild() {} },
    body: { prepend(node) { nodes.set(node.id, node); } },
    getElementById(id) { return nodes.get(id); }, querySelector() { return null; },
    createElement: element, addEventListener(type, fn) { listeners[type] = fn; },
  };
  let permissions = 0, signedOut = 0;
  const window = {
    location: { origin: 'https://www.assembleatease.com', href: 'https://www.assembleatease.com' + path,
      assign(url) { calls.push(['assign', url]); }, replace(url) { calls.push(['replace', url]); } },
    history: { length: 1, back() { calls.push(['back']); } },
    APP: {
      async getAuth() { return role ? { user: { id: 'user-1' }, profile: { role }, session: { access_token: 'test-bearer' } } : null; },
      clearPrivateSessionData() { signedOut++; },
    },
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {
      App: { addListener(type, fn) { events[type] = fn; }, async getInfo() { return { version: '1.0' }; } },
      AppLauncher: { async openUrl({ url }) { calls.push(['external', url]); if (options.failExternal) throw Error('test'); return { completed: true }; } },
      FirebaseMessaging: {
        addListener(type, fn) { events[type] = fn; },
        async checkPermissions() { permissions++; return { receive: 'prompt' }; },
        async requestPermissions() { return { receive: 'granted' }; },
        async getToken() { return { token: 'test-device' }; },
      },
    } },
  };
  const sandbox = { window, document, URL,
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    fetch: async (url, request) => { calls.push(['fetch', url, request]); return { ok: true }; },
  };
  vm.runInNewContext(source, sandbox);
  return { window, nodes, listeners, events, calls, storage, sandbox, permissions: () => permissions, signedOut: () => signedOut };
}
for (const path of ['/app', '/book', '/track', '/auth/login', '/assembler/my-assignments']) {
  const s = run(path);
  await flush();
  assert.equal(s.permissions(), 0, `${path}: guests are never asked for Easer push permission`);
  assert.equal(s.calls.filter(c => c[0] === 'fetch').length, 0);
}
for (const [path, role] of [['/book', 'assembler'], ['/track', 'customer'], ['/assembler/my-assignments', 'customer'], ['/assembler/my-assignments', 'owner']]) {
  const s = run(path, role); await flush();
  assert.equal(s.permissions(), 0, 'a route choice cannot grant Easer notifications');
}
{
  const s = run('/assembler/my-assignments', 'assembler'); await flush();
  assert.equal(s.permissions(), 1);
  const registration = s.calls.find(c => c[0] === 'fetch');
  assert.equal(registration[1], '/api/assembler/native-push-register');
  assert.equal(registration[2].headers.Authorization, 'Bearer test-bearer');
  assert.equal(s.storage.get('aae_native_push_token'), 'user-1:test-device');
  await s.events.tokenReceived({ token: 'rotated-device' }); await flush();
  assert.equal(s.storage.get('aae_native_push_token'), 'user-1:rotated-device');
  s.window.APP.clearPrivateSessionData();
  assert.equal(s.signedOut(), 1);
  assert.equal(s.calls.at(-1)[2].method, 'DELETE');
  assert.equal(JSON.parse(s.calls.at(-1)[2].body).token, 'rotated-device');
  assert.equal(s.storage.size, 0);
}
{
  const s = run('/book'); await flush();
  for (const target of ['https://example.com/steal', '//example.com', '/owner', '/api/owner/data', 'javascript:alert(1)', '']) {
    s.events.notificationActionPerformed({ notification: { data: { url: target } } });
    assert.equal(s.window.location.href, 'https://www.assembleatease.com/book', 'notification cannot open an arbitrary destination');
  }
  s.events.notificationActionPerformed({ notification: { data: { url: '/assembler/my-assignments?job=test' } } });
  assert.equal(s.window.location.href, '/assembler/my-assignments?job=test');
  const nav = s.nodes.get('aae-native-nav');
  assert.ok(nav);
  nav.children[0].click();
  assert.deepEqual(s.calls.at(-1), ['assign', '/app'], 'empty history returns to role choice');
  vm.runInNewContext(source, s.sandbox);
  assert.equal(s.nodes.get('aae-native-nav'), nav, 'shared loaders do not mount twice');
}
{
  const s = run('/app');
  assert.equal(s.nodes.get('aae-native-nav').hidden, true);
  let prevented = false;
  s.listeners.click({ target: { closest: () => ({ href: 'https://www.assembleatease.com/book' }) }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'physical service booking stays in the app');
}
{
  const s = run('/assembler/apply', null, { failExternal: true }); await flush();
  assert.equal(s.calls.some(c => c[0] === 'replace'), false, 'failed external handoff keeps the current screen');
  assert.equal(s.nodes.get('aae-native-link-error').hidden, false);
}
const entry = readFileSync('app.html', 'utf8');
for (const route of ['/book', '/track', '/assembler/my-assignments']) assert.ok(entry.includes(`href="${route}"`));
assert.match(entry, /name="robots" content="noindex, nofollow"/);
assert.equal(JSON.parse(readFileSync('mobile/capacitor.config.json')).server.url, 'https://www.assembleatease.com/app');
console.log('PASS native routes: guest booking, role-gated push, sign-out, safe navigation, failed handoff, and one shared entry.');
