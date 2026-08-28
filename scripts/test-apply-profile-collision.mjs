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
  assert.ok(/authUserCreated \|\| applicationPlaceholder/.test(block),
    'a profile inserted by the auth signup trigger must be adopted by the same application');
  assert.ok(/applicationAttemptMatches[\s\S]*authUser\.user_metadata\?\.application_attempt_hash/.test(block),
    'an existing placeholder must be owned by the same high-entropy application attempt');
  assert.ok(/const applicationPlaceholder = !appStatus/.test(block),
    'only an unfinished placeholder may use the application-attempt recovery path');
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

// ── A typo must not cost an applicant their attempt ────────────────────────
{
  // The limiter used to run BEFORE validation, so "City is required" spent one of
  // only three attempts. Two typos plus the profiles_pkey collision locked an
  // applicant out of their own application with "Too many requests" and no cause.
  const limiterAt = src.indexOf("rateLimit(ip, 'apply')");
  const firstDbCall = src.indexOf('const sb = getSupabase();');
  const firstValidation = src.indexOf("'Full name is required'");

  assert.ok(limiterAt > -1, 'the apply route must still be rate limited');
  assert.ok(firstValidation < limiterAt,
    'validation must run BEFORE the limiter — a typo must never consume an attempt');
  assert.ok(limiterAt < firstDbCall,
    'the limiter must sit immediately before the first expensive call');

  // Everything ahead of the limiter must be free: no database, no Stripe, no email.
  const preamble = src.slice(src.indexOf('export default async function handler'), limiterAt);
  assert.ok(!/getSupabase\(\)|stripe\.|sendEmail\(/.test(preamble),
    'nothing expensive may run before the limiter, or it is not protecting anything');

  assert.ok(/wait about 10 minutes/.test(src),
    'a wait with no duration is not an instruction — the message must say how long');
  assert.ok(/your answers are still in the form/.test(src),
    'the applicant must be told their work is not lost, which is what they actually fear');
  console.log('PASS validation is free; only real submission attempts are rate limited');
}

// ── A waitlist signup must not block its own email forever ─────────────────
{
  // Someone who joined the waitlist because their area was not live, and now
  // applies properly, is not a duplicate. Excluding 'waitlist' meant that row
  // permanently blocked the email — and because the rejection sits after the
  // rate limiter, five attempts to discover it cost the applicant their quota.
  const fn = src.slice(src.indexOf('function isRecoverableApplication('));
  const body = fn.slice(0, fn.indexOf('\nasync function resumeApplicationDraft'));
  assert.ok(/'waitlist'/.test(body),
    'a waitlist profile must be resumable — it is the upgrade path, not a duplicate');
  for (const s of ['payment_pending', 'applied']) {
    assert.ok(body.includes(s) || body.includes('APPLICATION_PAYMENT_PENDING'),
      `${s} must remain resumable`);
  }
  assert.ok(/\['', APPLICATION_PAYMENT_PENDING/.test(body),
    'a same-attempt trigger-created profile with no application status must be resumable');
  // An approved or active Easer must still never be resumable through this path.
  assert.ok(/status === 'pending'/.test(body),
    'only a pending account may be resumed — an approved Easer is not an application');
  console.log('PASS a waitlist signup can still apply; an approved Easer still cannot be overwritten');
}

console.log('\nApply profile-collision tests passed.');
