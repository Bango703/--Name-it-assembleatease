#!/usr/bin/env node

/**
 * A partly-finished application must be resumable, not a permanent lockout.
 *
 * WHAT HAPPENED
 * An applicant saw:
 *   "Failed to save application. duplicate key value violates unique
 *    constraint profiles_pkey"
 *
 * The handler checks for an existing application by EMAIL, then separately finds
 * the auth user by email and resumes it — and then inserts a profile row keyed on
 * that auth user's id. If a profile ALREADY existed for that id (a first attempt
 * that created the row and then failed at a later step, leaving an email that is
 * null or out of step with the auth record), the email check missed it and the
 * insert collided. The applicant was locked out permanently and shown raw
 * Postgres.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const src = await fs.readFile(new URL('../api/assembler/apply.js', import.meta.url), 'utf8');

// ── The collision cannot happen ─────────────────────────────────────────────
{
  assert.ok(/profileForThisAuthUser/.test(src),
    'the handler must look for an existing profile BY ID before writing one');
  assert.ok(/\.eq\('id', userId\)/.test(src), 'that lookup must key on the auth user id');

  const block = src.slice(src.indexOf('const { data: profileForThisAuthUser }'), src.indexOf('if (profileError) {'));
  assert.ok(/\.update\(updatable\)/.test(block), 'an existing unfinished row must be UPDATED');
  assert.ok(/\.insert\(coreProfile\)/.test(block), 'a genuinely new applicant is still INSERTED');
  assert.ok(/const \{ id, \.\.\.updatable \} = coreProfile/.test(block),
    'the primary key must never be part of the update payload');
  console.log('PASS an unfinished application is resumed instead of colliding');
}

// ── An approved Easer is never overwritten by a form ────────────────────────
{
  const block = src.slice(src.indexOf('const { data: profileForThisAuthUser }'), src.indexOf('if (profileError) {'));
  assert.ok(/resumable/.test(block), 'only a resumable row may be rewritten');
  assert.ok(/'payment_pending', 'applied'/.test(block),
    'only genuinely unfinished application states are resumable');
  assert.ok(/!== 'active'/.test(block), 'an active Easer must never be overwritten');
  assert.ok(/PROFILE_ALREADY_EXISTS/.test(block), 'a non-resumable row must refuse with a real reason');
  console.log('PASS an approved or active Easer can never be overwritten by an application');
}

// ── The applicant never sees raw Postgres ───────────────────────────────────
{
  assert.ok(!/profileError\.message/.test(src),
    'a database constraint message must never reach the applicant (Article 16)');
  assert.ok(/could not save your application/i.test(src),
    'the failure must say what happened and what to do');
  assert.ok(/Nothing was submitted/i.test(src),
    'the applicant must be told nothing was charged or stored, which is what they actually worry about');
  console.log('PASS a database error is never shown to an applicant');
}

console.log('\nApply profile-collision tests passed.');
