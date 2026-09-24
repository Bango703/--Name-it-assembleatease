#!/usr/bin/env node
// No upload path may invent its own size limit.
//
// THE BUG. Every upload screen capped the file at 5 MB and then base64-encoded
// it into a JSON body. Base64 adds a third, and Vercel rejects any request body
// over 4.5 MB with a 413 before the function runs. A 4 MB completion photo
// became a 5.4 MB body that never reached the endpoint: nothing logged, and the
// Easer was shown "Connection error" because the client tried to JSON.parse a
// 413. Under ~3.3 MB it worked, over it never could, so whether job completion
// worked at all came down to which phone the Easer was holding.
//
// Six screens and four endpoints each carried their own copy of the same wrong
// number. This file exists so that cannot recur: the ceiling is DERIVED from
// the platform limit, the browser mirror must agree with the server, and every
// page that posts a fileBase64 must go through the one helper that shrinks the
// image first.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as server from '../api/_upload-limits.js';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

// ── 1. The ceiling is derived, and it is below the platform limit ───────────
assert.equal(server.VERCEL_BODY_LIMIT_BYTES, Math.floor(4.5 * 1024 * 1024),
  'Vercel documents a 4.5 MB request body limit; changing this constant changes what ships');

const encodedBodyOf = raw => Math.ceil(raw * server.BASE64_EXPANSION) + server.JSON_ENVELOPE_BYTES;
assert.ok(encodedBodyOf(server.MAX_UPLOAD_BYTES) < server.VERCEL_BODY_LIMIT_BYTES,
  'a file at exactly MAX_UPLOAD_BYTES must still fit once base64-encoded');
assert.ok(encodedBodyOf(5 * 1024 * 1024) > server.VERCEL_BODY_LIMIT_BYTES,
  'the old 5 MB cap must be provably impossible, or this test is not testing anything');
assert.ok(server.MAX_UPLOAD_BYTES < 5 * 1024 * 1024 && server.MAX_UPLOAD_BYTES > 2 * 1024 * 1024,
  'the derived ceiling landed somewhere implausible');

// ── 2. The browser mirror agrees with the server ────────────────────────────
// No bundler here, so the numbers are duplicated on purpose. They may never
// disagree: the browser deciding a file fits when the platform disagrees is the
// entire original bug.
const browser = {};
new Function('window', 'document', await read('assets/js/image-upload.js'))(browser, { createElement: () => ({}) });
const U = browser.AAE_UPLOAD;
assert.ok(U, 'assets/js/image-upload.js must expose window.AAE_UPLOAD');
assert.equal(U.MAX_UPLOAD_BYTES, server.MAX_UPLOAD_BYTES, 'browser mirror drifted from api/_upload-limits.js');
assert.equal(U.IMAGE_MAX_EDGE_PX, server.IMAGE_MAX_EDGE_PX, 'browser mirror drifted on IMAGE_MAX_EDGE_PX');
assert.equal(U.IMAGE_JPEG_QUALITY, server.IMAGE_JPEG_QUALITY, 'browser mirror drifted on IMAGE_JPEG_QUALITY');
assert.equal(U.UPLOAD_TOO_LARGE_MESSAGE, server.UPLOAD_TOO_LARGE_MESSAGE, 'one wording for one condition');

// ── 3. A 413 is explained, not swallowed ────────────────────────────────────
// This is what the Easer actually saw. Vercel's 413 is not JSON, so calling
// .json() on it throws and the catch reported a connection problem that did not
// exist. Retrying could never help.
assert.equal(
  await U.describeUploadFailure({ status: 413, json: () => Promise.reject(new Error('not json')) }),
  server.UPLOAD_TOO_LARGE_MESSAGE,
  'a 413 must be explained as a size problem without parsing a body it does not have',
);
assert.equal(
  await U.describeUploadFailure({ status: 409, json: () => Promise.resolve({ error: 'Start the job first.' }) }),
  'Start the job first.',
  'a real server error must still reach the user unchanged',
);
assert.match(
  await U.describeUploadFailure({ status: 502, json: () => Promise.reject(new Error('not json')) }),
  /502/,
  'an unparseable failure must name its status rather than blame the connection',
);

// ── 4. Every endpoint reads the shared ceiling ──────────────────────────────
const ENDPOINTS = [
  'api/booking/upload-evidence.js',
  'api/booking/customer-photos.js',
  'api/owner/upload-completion-evidence.js',
  'api/owner/supply-easer-evidence.js',
];
for (const file of ENDPOINTS) {
  const src = await read(file);
  assert.match(src, /import \{ MAX_UPLOAD_BYTES \} from '\.\.\/(_upload-limits|\.\.\/api\/_upload-limits)\.js'/,
    `${file} must import the shared ceiling`);
  assert.match(src, /MAX_(RAW_)?BYTES = MAX_UPLOAD_BYTES/, `${file} must use it as its own limit`);
  assert.doesNotMatch(src, /5 \* 1024 \* 1024/, `${file} still hardcodes 5 MB`);
  // bodyParser cannot raise the platform limit, so a number above it is a lie
  // that reads as permission.
  const declared = src.match(/sizeLimit: '(\d+)mb'/);
  if (declared) {
    assert.ok(Number(declared[1]) * 1024 * 1024 <= server.VERCEL_BODY_LIMIT_BYTES * 1.2,
      `${file} declares a bodyParser sizeLimit of ${declared[1]}mb, well above what can ever arrive`);
  }
}

// ── 5. Every screen that posts a photo shrinks it first ─────────────────────
// Keyed on fileBase64 so the rule finds new upload screens automatically.
// assembler/profile.html is deliberately absent: the avatar is already drawn to
// a 384px canvas and capped at 350 KB, and it posts profile_photo, not fileBase64.
const PAGES = ['assembler/my-assignments.html', 'assembler/index.html', 'owner/index.html', 'track.html'];
for (const page of PAGES) {
  const src = await read(page);
  assert.ok(src.includes('/assets/js/image-upload.js'), `${page} must load the shared upload helper`);
  assert.ok(src.includes('AAE_UPLOAD.prepare('), `${page} must shrink the image before sending it`);
  assert.doesNotMatch(src, /5 \* 1024 \* 1024/, `${page} still enforces the impossible 5 MB cap`);
  assert.ok(src.includes('AAE_UPLOAD.describeUploadFailure('),
    `${page} must explain a failed upload rather than assume the response is JSON`);
}

// Nothing may read the original file straight into an upload body again.
for (const page of PAGES) {
  const src = await read(page);
  for (const [, body] of src.matchAll(/fileBase64\s*:\s*([A-Za-z_$][\w$.]*)/g)) {
    assert.ok(/^(prepared|_\w+)\./.test(body) || body.startsWith('prepared'),
      `${page} posts fileBase64 from "${body}" — it must come from an AAE_UPLOAD.prepare() result`);
  }
  for (const [, mime] of src.matchAll(/mimeType\s*:\s*([A-Za-z_$][\w$.]*)/g)) {
    assert.doesNotMatch(mime, /^file\.type$/,
      `${page} sends the raw file.type; send the prepared mimeType so a HEIC re-encoded to JPEG is declared honestly`);
  }
}

console.log('PASS upload limits: derived ceiling, mirror parity, honest 413, every screen shrinks first');
