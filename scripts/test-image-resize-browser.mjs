#!/usr/bin/env node
// Runs assets/js/image-upload.js in a real browser engine.
//
// WHY A BROWSER. The rest of the upload guarding is static: it proves every
// screen CALLS prepare() and that the numbers agree. None of it can prove
// prepare() actually works, because the resize happens on a canvas and Node has
// no canvas. That gap is exactly where the original bug lived — the wiring was
// fine, the photo was simply too big — so "the wiring is present" is not the
// assertion that matters. This one loads the shipped file into Chromium,
// generates photos at the resolutions real phones shoot, and checks what comes
// out the other side.
//
// SKIPS, never fails, when no Chromium is installed. A missing browser is not a
// broken upload path, and a guard that blocks a machine without Edge would just
// get deleted by the next person in a hurry.

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as limits from '../api/_upload-limits.js';

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const browser = CANDIDATES.find(path => { try { return existsSync(path); } catch { return false; } });
if (!browser) {
  console.log('SKIP image resize in-browser check: no Chromium found (set CHROME_PATH to run it)');
  process.exit(0);
}

// WebSocket became a global in Node 22; CI still runs 20, where a Chromium IS
// present so the check above passes and the devtools connection then dies on a
// ReferenceError. An old runtime is an environment limit, not a broken upload
// path, so it skips like a missing browser does.
if (typeof WebSocket === 'undefined') {
  console.log(`SKIP image resize in-browser check: Node ${process.versions.node} has no global WebSocket (needs 22+)`);
  process.exit(0);
}

const moduleSrc = await readFile(new URL('../assets/js/image-upload.js', import.meta.url), 'utf8');

const harness = `<!DOCTYPE html><meta charset="utf-8"><body><pre id="out">pending</pre>
<script>${moduleSrc}</script>
<script>
window.__aaeDone = (function () {
  var MAX = ${limits.MAX_UPLOAD_BYTES};
  var EDGE = ${limits.IMAGE_MAX_EDGE_PX};
  // A noise tile stamped edge to edge at 1:1. Noise is what stops the JPEG
  // encoder shrinking the fixture to nothing and handing back a false pass on a
  // file that was never actually large. Tiling rather than filling every pixel
  // individually keeps a 24 MP fixture from taking minutes to build.
  var TILE = (function () {
    var t = document.createElement('canvas');
    t.width = 256; t.height = 256;
    var tc = t.getContext('2d');
    var d = tc.createImageData(256, 256);
    for (var i = 0; i < d.data.length; i += 4) {
      d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255;
      d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255;
    }
    tc.putImageData(d, 0, 0);
    return t;
  })();
  function photo(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    for (var y = 0; y < h; y += 256) {
      for (var x = 0; x < w; x += 256) ctx.drawImage(TILE, x, y);
    }
    return new Promise(function (res) {
      c.toBlob(function (b) { res(new File([b], 'p.jpg', { type: 'image/jpeg' })); }, 'image/jpeg', 0.92);
    });
  }
  function measure(dataUrl) {
    return new Promise(function (res, rej) {
      var i = new Image();
      i.onload = function () { res({ w: i.naturalWidth, h: i.naturalHeight }); };
      i.onerror = function () { rej(new Error('output image did not decode')); };
      i.src = dataUrl;
    });
  }
  // The resolutions phones actually shoot: 12 MP is the long-standing iPhone
  // default, 24 MP the current Pro default. Both were over the old ceiling.
  var CASES = [[4032, 3024, '12MP'], [5712, 4284, '24MP'], [1024, 768, 'small']];
  var out = { pass: true, cases: [], error: null };
  return Promise.all(CASES.map(function (c) { return photo(c[0], c[1]); }))
    .then(function (files) {
      return Promise.all(files.map(function (f, i) {
        return window.AAE_UPLOAD.prepare(f).then(function (p) {
          return measure(p.dataUrl).then(function (size) {
            return { name: CASES[i][2], original: f.size, sent: p.bytes, mime: p.mimeType, w: size.w, h: size.h };
          });
        });
      }));
    })
    .then(function (rows) {
      rows.forEach(function (r) {
        r.fits = r.sent <= MAX;
        r.scaled = Math.max(r.w, r.h) <= EDGE;
        r.jpeg = r.mime === 'image/jpeg';
        r.wasLarge = r.name === 'small' || r.original > MAX;
        if (!r.fits || !r.scaled || !r.jpeg || !r.wasLarge) out.pass = false;
        out.cases.push(r);
      });
    })
    .then(function () {
      // A format this browser cannot decode cannot be shrunk. A big one must be
      // refused in words; a small one must still go through untouched. This is
      // the iPhone-HEIC-on-Chrome path, and the only branch where the ceiling
      // check is actually reachable.
      var bigHeic = new File([new Uint8Array(MAX + 1024)], 'big.heic', { type: 'image/heic' });
      var smallHeic = new File([new Uint8Array(2048)], 'small.heic', { type: 'image/heic' });
      return window.AAE_UPLOAD.prepare(bigHeic)
        .then(function () { out.undecodableBig = 'ACCEPTED an oversized file it cannot shrink'; },
              function (e) { out.undecodableBig = e.message; })
        .then(function () { return window.AAE_UPLOAD.prepare(smallHeic); })
        .then(function (p) { out.undecodableSmall = p.mimeType + ':' + p.bytes; },
              function (e) { out.undecodableSmall = 'REJECTED ' + e.message; });
    })
    .catch(function (e) { out.pass = false; out.error = String((e && e.message) || e); })
    .then(function () { return out; });
})();
</script>`;

const dir = await mkdtemp(join(tmpdir(), 'aae-resize-'));
const page = join(dir, 'harness.html');
await writeFile(page, harness);

// --dump-dom returns as soon as the page is loaded, which is long before a
// 24 MP JPEG has finished encoding, so the first version of this test always
// read "pending" and proved nothing. Drive the page over the devtools protocol
// and actually await the promise instead.
const PORT = 9333 + (process.pid % 500);
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  '--disable-background-timer-throttling', '--mute-audio',
  `--user-data-dir=${join(dir, 'profile')}`,
  `--remote-debugging-port=${PORT}`,
  'file:///' + page.replace(/\\/g, '/'),
], { stdio: 'ignore' });

const cleanup = async () => {
  try { child.kill(); } catch { /* already gone */ }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
};

async function target(deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const found = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (found) return found.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

const wsUrl = await target(Date.now() + 30000);
if (!wsUrl) {
  await cleanup();
  console.log('SKIP image resize in-browser check: devtools endpoint never opened');
  process.exit(0);
}

let result;
try {
  result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } reject(new Error('timed out waiting for the harness')); }, 150000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      // The harness assigns its promise synchronously at parse time, so by the
      // time a page target exists this resolves to the finished run.
      params: { expression: 'window.__aaeDone', awaitPromise: true, returnByValue: true },
    }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('devtools socket error')); };
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* closing */ }
      if (msg.error) return reject(new Error(msg.error.message));
      if (msg.result?.exceptionDetails) return reject(new Error(msg.result.exceptionDetails.text));
      resolve(msg.result?.result?.value);
    };
  });
} catch (err) {
  await cleanup();
  throw new Error(`in-browser resize check could not complete: ${err.message}`);
}
await cleanup();

assert.ok(result && Array.isArray(result.cases), 'the harness returned nothing usable');

assert.equal(result.error, null, `prepare() threw in the browser: ${result.error}`);
assert.equal(result.cases.length, 3, 'every test photo must produce a result');

for (const c of result.cases) {
  assert.ok(c.wasLarge, `${c.name}: the fixture was only ${c.original} bytes, so it never tested the limit`);
  assert.ok(c.jpeg, `${c.name}: output must be re-encoded JPEG, got ${c.mime}`);
  assert.ok(c.scaled, `${c.name}: output is ${c.w}x${c.h}, longer than the ${limits.IMAGE_MAX_EDGE_PX}px edge`);
  assert.ok(c.fits, `${c.name}: output is ${c.sent} bytes, over the ${limits.MAX_UPLOAD_BYTES} ceiling`);
}

assert.equal(result.undecodableBig, limits.UPLOAD_TOO_LARGE_MESSAGE,
  'a file too big to send and impossible to shrink must be refused in plain words, not attempted');
assert.match(String(result.undecodableSmall), /^image\/heic:\d+$/,
  'a small undecodable file must pass through with its own type, not be rejected');

// The whole point: the photos that used to be rejected now sail under the limit.
const big = result.cases.filter(c => c.original > limits.MAX_UPLOAD_BYTES);
assert.ok(big.length >= 1, 'at least one fixture must have been too large before the fix, or nothing was proven');
assert.ok(result.pass, 'the in-browser harness reported a failure');

const line = result.cases
  .map(c => `${c.name} ${(c.original / 1048576).toFixed(1)}MB -> ${Math.round(c.sent / 1024)}KB ${c.w}x${c.h}`)
  .join(' | ');
console.log(`PASS image resize in a real browser: ${line}`);
