#!/usr/bin/env node

/**
 * A missing OPTIONAL column must never cost us the send status.
 *
 * WHAT HAPPENED
 * On 2026-08-27 at 11:51 CDT a deploy started writing provider_accepted_at
 * (migration 068) into notification_log. PostgREST rejected the whole UPDATE
 * because it did not know that column. finalizeNotificationLog caught the error,
 * logged to a console nobody was watching, and returned — leaving the row at
 * 'queued'.
 *
 * For the next twelve hours every email delivered perfectly and every single one
 * was recorded as never sent. Resend's own dashboard showed 15 delivered
 * messages the platform reported as queued, including an Easer job assignment
 * the owner then believed had silently failed.
 *
 * insertNotificationLog had tolerated exactly this for migration 053's column
 * since it was written. finalize did not. These tests hold both halves to the
 * same contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const src = await fs.readFile(new URL('../api/_email.js', import.meta.url), 'utf8');

// ── The fallback exists at all ──────────────────────────────────────────────
{
  assert.ok(src.includes('OPTIONAL_DELIVERY_COLUMNS'),
    'the optional delivery-truth columns must be named in one place, not repeated inline');
  assert.ok(src.includes('provider_accepted_at'),
    'provider_accepted_at is the column that broke production and must be listed as optional');
  console.log('PASS optional delivery columns are declared in one place');
}

// ── Finalize retries without them ───────────────────────────────────────────
{
  const finalize = src.slice(src.indexOf('async function finalizeNotificationLog'));
  const body = finalize.slice(0, finalize.indexOf('\nasync function reconcileEarlyProviderEvent'));

  assert.ok(/isMissingColumnError\(/.test(body),
    'finalize must detect a missing-column rejection rather than treating it as a hard failure');
  assert.ok(/delete corePayload\[col\]/.test(body),
    'finalize must strip the optional columns and retry — the status is the fact that matters');
  assert.ok(/update\(corePayload\)/.test(body),
    'the retry must actually issue a second update');
  assert.ok(/degraded/.test(body),
    'a degraded write must say so rather than silently claiming a clean one (Article 16)');
  console.log('PASS finalize strips optional columns and retries instead of losing the status');
}

// ── Both writers share the contract ─────────────────────────────────────────
{
  const insert = src.slice(src.indexOf('async function insertNotificationLog'));
  const insertBody = insert.slice(0, insert.indexOf('\nasync function finalize'));
  assert.ok(/42703|PGRST204/.test(insertBody),
    'insert tolerates a missing optional column');

  const finalize = src.slice(src.indexOf('function isMissingColumnError'));
  assert.ok(/42703/.test(finalize) && /PGRST204/.test(finalize),
    'finalize must recognise the SAME rejection codes as insert — the asymmetry between them is what broke production');
  console.log('PASS insert and finalize recognise the same schema-rejection codes');
}

// ── The status must never be optional ───────────────────────────────────────
{
  const idx = src.indexOf('const OPTIONAL_DELIVERY_COLUMNS');
  const decl = src.slice(idx, src.indexOf(']', idx));
  for (const required of ['status', 'provider_id', 'error_text']) {
    assert.ok(!decl.includes(`'${required}'`),
      `${required} must NEVER be droppable — dropping it is exactly the data loss this guards against`);
  }
  console.log('PASS status, provider_id and error_text can never be dropped as "optional"');
}

console.log('\nEmail log schema-tolerance tests passed.');
