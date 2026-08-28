#!/usr/bin/env node

/**
 * The platform must tell the owner what it already knows is broken.
 *
 * Three separate outages in one day were recorded with their exact cause and
 * surfaced nowhere:
 *
 *   notification_audit_failed  x5   "Could not find the 'provider_accepted_at'
 *                                    column of 'notification_log'"
 *                                   -> 12 hours of delivered mail logged as unsent
 *   financial_event_audit      failed  "no valid server-priced booking total"
 *                                   -> a refund that never reached the books
 *   assignment threw after committing -> Easer assigned, no email, owner shown 500
 *
 * Every one was found by hand, hours or months late. The data was always there.
 * Nothing read it back.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const api = await fs.readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8');
const ui = await fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

// ── The server reads its own failure records ────────────────────────────────
{
  assert.ok(/loadSelfDiagnosedFailures/.test(api), 'Live Ops must gather self-diagnosed failures');
  assert.ok(/from\('financial_event_audit'\)[\s\S]{0,200}\.eq\('status', 'failed'\)/.test(api),
    'failed financial events must be read back — a refund that never reconciled lives here');
  for (const kind of ['notification_audit_failed', 'dispatch_notification_failed', 'acceptance_notification_failed']) {
    assert.ok(api.includes(kind), `${kind} must be surfaced`);
  }
  assert.ok(/selfDiagnosed,/.test(api), 'the findings must ship in the Live Ops payload');
  console.log('PASS the server reads back the failures it already recorded');
}

// ── Diagnostics can never break the dashboard ───────────────────────────────
{
  const fn = api.slice(api.indexOf('async function loadSelfDiagnosedFailures'));
  const body = fn.slice(0, fn.indexOf('\nexport default'));
  assert.equal((body.match(/catch \(err\)/g) || []).length, 2,
    'both lookups must be individually caught — one failing must not lose the other');
  assert.ok(!/throw /.test(body), 'the gatherer must never throw');
  assert.ok(/try \{ renderSelfDiagnosed\(d\); \} catch/.test(ui),
    'the renderer must be wrapped — a diagnostics panel must never blank Live Ops');
  console.log('PASS a failing diagnostics lookup can never take down the dashboard');
}

// ── It shows the real cause, and stays quiet when healthy ───────────────────
{
  assert.ok(/r\.error \|\| 'no reason recorded'/.test(api),
    "the server's own error text must be passed through, not replaced with something generic");
  assert.ok(/emailLogError \|\| r\.metadata\?\.pushLogError/.test(api),
    'the captured cause must be surfaced — that string is what made the outage findable');

  const fn = ui.slice(ui.indexOf('function renderSelfDiagnosed('));
  const body = fn.slice(0, fn.indexOf('\n  function arrivalBadge('));
  assert.ok(/if \(!sd \|\| !sd\.total\)[\s\S]{0,80}display = 'none'/.test(body),
    'a healthy platform must show nothing — a permanent banner is ignored within a week');
  assert.ok(/no reason recorded/.test(body), 'a missing cause must say so rather than invent one');
  console.log('PASS it shows the real cause, and disappears entirely when nothing is wrong');
}

console.log('\nSelf-diagnosed failure tests passed.');
