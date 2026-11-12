import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Owner, 2026-11-12: the "Install app / Add AssembleAtEase to your home screen"
// prompt on Easer pages is removed. Easers get the Easer app from the App Store,
// offered by Apple's Smart App Banner on Easer pages (scripts/app-banner-sync.mjs).
// The service worker stays: web job notifications on Android and desktop use it.

const root = new URL('../', import.meta.url);
const read = rel => readFile(new URL(rel, root), 'utf8');

const appJs = await read('assets/js/app.js');
assert.doesNotMatch(appJs, /aae-install|Add AssembleAtEase to your home screen|Add to Home Screen|beforeinstallprompt|initPWAInstall/,
  'no install prompt on Easer pages');
assert.match(appJs, /\(function initEaserServiceWorker\(\) \{/);
assert.match(appJs, /if \(location\.pathname\.indexOf\('\/assembler'\) !== 0\) return;/, 'Easer routes only');
assert.match(appJs, /if \(window\.AAE_isNativeApp && window\.AAE_isNativeApp\(\)\) return;/, 'never inside the store app');
assert.match(appJs, /navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/assembler\/' \}\)/, 'the service worker is still registered');

assert.doesNotMatch(await read('assets/css/easer.css'), /aae-install-pill/, 'no leftover style for the removed prompt');

const easerPage = await read('assembler/my-assignments.html');
assert.match(easerPage, /<meta name="apple-itunes-app" content="app-id=6820654960">/, 'Easer pages offer the Easer app through Apple\'s banner instead');

console.log('PASS Easer pages: no install prompt; service worker kept; the App Store banner offers the Easer app');
