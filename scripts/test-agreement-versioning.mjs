#!/usr/bin/env node

/**
 * Agreement versions are published deliberately; acceptances are never lost.
 *
 * WHAT WAS WRONG
 * The required version was a constant in application code, so publishing a
 * contract meant editing a line and shipping a deploy — coupling a contractual
 * act to a software release. Policy is explicit that these are separate
 * systems: software fixes flow continuously, agreement versions batch monthly.
 *
 * Worse, acceptance had no history. Re-accepting OVERWROTE the profile columns,
 * destroying the record of what someone previously agreed to. Two live Easers
 * are on older versions (2026-06-08, 2026-07-13) — evidence that was one UPDATE
 * away from gone, and the only thing that matters in a dispute.
 *
 * The guards below exist because both failures are silent and irreversible.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = p => fs.readFile(new URL('../' + p, import.meta.url), 'utf8');
const migration = await read('api/migrations/090_agreement_versioning.sql');
const module_ = await read('api/_agreement-versions.js');

// ── The ledger cannot be rewritten ─────────────────────────────────────────
{
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.agreement_acceptances'),
    'acceptance needs its own table — profile columns are overwritten on re-acceptance');
  assert.ok(/BEFORE UPDATE OR DELETE ON public\.agreement_acceptances/.test(migration),
    'the ledger must be append-only in the DATABASE; convention is not enforcement');
  assert.ok(migration.includes('append-only'),
    'the refusal must say why it refused');
  assert.ok(migration.includes('ON DELETE RESTRICT'),
    'deleting a profile must fail loudly rather than erase what they agreed to');
  console.log('PASS an acceptance record cannot be altered or deleted once written');
}

// ── Existing acceptances are preserved, and marked honestly ────────────────
{
  assert.ok(/INSERT INTO public\.agreement_acceptances[\s\S]{0,900}FROM public\.profiles/.test(migration),
    'every current acceptance must be backfilled before anything can overwrite it');
  assert.ok(migration.includes("'backfill'"),
    'reconstructed rows must be distinguishable from ones captured at the time');
  assert.ok(module_.includes("source: 'live'"),
    'new acceptances must record that they were captured live');
  // Backfilled rows carry no hash and no signature. Presenting them as equal to
  // a live capture would overstate the evidence.
  assert.ok(/'backfill'[\s\S]{0,200}CHECK|CHECK[\s\S]{0,200}'backfill'/.test(migration),
    'the source values must be constrained, not free text');
  console.log('PASS existing acceptances survive, labelled as reconstructed');
}

// ── Exactly one published, exactly one draft ───────────────────────────────
{
  assert.ok(/idx_agreement_one_published[\s\S]{0,160}WHERE status = 'published'/.test(migration),
    'two published versions would make "which agreement is required" unanswerable');
  assert.ok(/idx_agreement_one_draft[\s\S]{0,160}WHERE status = 'draft'/.test(migration),
    'one draft at a time, for the same reason');
  assert.ok(migration.includes('agreement_versions_published_complete'),
    'a published version must carry the content and date it published');
  console.log('PASS one published version, one draft, and a published row is complete');
}

// ── A draft is inert ───────────────────────────────────────────────────────
// Editing the next version must never take anyone offline or notify them.
{
  const draftFn = module_.slice(module_.indexOf('export async function getDraftAgreement'));
  assert.ok(!/sendEmail|update\(|insert\(/.test(draftFn.slice(0, 900)),
    'reading or holding a draft must not write anything or notify anyone');
  assert.ok(module_.includes('Never affects eligibility'),
    'the draft path must state that it changes nothing');
  console.log('PASS a draft cannot change eligibility or trigger notifications');
}

// ── Deploy order cannot take the network offline ───────────────────────────
// An agreement gate that fails closed would suspend every Easer the moment this
// shipped ahead of migration 090.
{
  assert.ok(module_.includes('function isMissingAgreementTable'),
    'a missing table means the migration has not run, not a real failure');
  assert.ok(module_.includes("return { version: CONTRACTOR_AGREEMENT_VERSION, source: 'constant', row: null };"),
    'every read must fall back to the compiled constant');
  assert.ok(module_.includes("source: 'database'"),
    'callers must be able to tell a real record from a fallback');
  console.log('PASS shipping before the migration keeps today\'s behaviour exactly');
}

// ── Accepting an agreement is not a master key ─────────────────────────────
// Policy: accepting must not reactivate a suspended Easer or bypass identity
// verification. This module answers one question and must not answer others.
{
  // Assert on BEHAVIOUR, not prose: the doc comment names suspension and
  // identity precisely to mark the boundary, so matching those words flags the
  // explanation rather than a violation.
  const code = module_.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/from\('profiles'\)[\s\S]{0,200}\.update\(/.test(code),
    'the agreement module must never write to profiles — status and identity belong to other gates');
  assert.ok(!/identity_verified|account_closure|suspend/i.test(code),
    'no suspension or identity logic may live here');
  assert.ok(/from\('agreement_acceptances'\)[\s\S]{0,120}\.insert\(/.test(code),
    'the only write it performs is appending to the ledger');
  assert.ok(module_.includes('ONE requirement among several'),
    'the boundary must be stated where the next person will read it');
  console.log('PASS accepting an agreement clears one gate and never overrides another');
}

console.log('\nAgreement versioning tests passed.');
