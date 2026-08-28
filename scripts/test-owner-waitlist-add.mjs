#!/usr/bin/env node

/**
 * The owner can put someone on the Easer waitlist, and location means something.
 *
 * Supply is half of a two-sided marketplace and it was the half with no inbox:
 * the waitlist could only be joined from the public form, so a promising person
 * met on a job site lived in a phone's notes app, which is to say they were lost.
 *
 * Two things had to be true before the owner door was safe to open:
 *
 *   ONE RULE, NOT TWO. A second copy of "is this a real email, a real city, a
 *   real state" in the owner handler is the exact shape Article 3 forbids — the
 *   copies drift the first time one is fixed and the other is not. Both doors
 *   call validateWaitlistInput.
 *
 *   THE PERSON DID NOT ASK US FOR ANYTHING. An owner-added name never filled in
 *   a form, so emailing them is a cold email: it stays an explicit decision that
 *   defaults to off, and when it is sent it must not claim they signed up.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateWaitlistInput, WAITLIST_SOURCE } from '../api/_waitlist-core.js';
import { buildWaitlistEmail } from '../api/_waitlist-email.js';

const core      = await fs.readFile(new URL('../api/_waitlist-core.js', import.meta.url), 'utf8');
const publicFn  = await fs.readFile(new URL('../api/waitlist.js', import.meta.url), 'utf8');
const ownerFn   = await fs.readFile(new URL('../api/owner/waitlist.js', import.meta.url), 'utf8');
const ui        = await fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
const migration = await fs.readFile(new URL('../api/migrations/082_waitlist_owner_add.sql', import.meta.url), 'utf8');

const VALID = { name: 'Trapper Riney', email: 'trapper@example.com', phone: '5125550134', city: 'Austin', state: 'TX' };

// ── One validator, used by both doors ───────────────────────────────────────
{
  assert.ok(publicFn.includes('validateWaitlistInput'), 'the public form must use the shared validator');
  assert.ok(ownerFn.includes('validateWaitlistInput'), 'the owner add must use the shared validator');

  // The rules must live in exactly one file. If these reappear in a handler,
  // someone has started a second copy.
  for (const [file, name] of [[publicFn, 'api/waitlist.js'], [ownerFn, 'api/owner/waitlist.js']]) {
    assert.ok(!file.includes('BLOCKED_DOMAINS = new Set'), name + ' must not keep its own disposable-domain list');
    assert.ok(!file.includes('US_STATE_CODES = new Set'), name + ' must not keep its own state list');
  }
  console.log('PASS both waitlist doors validate through one module');
}

// ── The validator actually refuses bad input ────────────────────────────────
{
  assert.equal(validateWaitlistInput(VALID).ok, true, 'a good record must be accepted');

  const rejects = [
    ['a made-up state', { ...VALID, state: 'ZZ' }],
    ['a disposable email', { ...VALID, email: 'someone@mailinator.com' }],
    ['a gibberish city', { ...VALID, city: 'aaaaa' }],
    ['a missing phone', { ...VALID, phone: '' }],
    ['a malformed email', { ...VALID, email: 'not-an-email' }],
  ];
  for (const [label, body] of rejects) {
    const r = validateWaitlistInput(body);
    assert.equal(r.ok, false, label + ' must be rejected');
    assert.ok(r.error && r.error.length > 10,
      label + ' must be refused with a reason a human can act on (Article 14)');
  }
  console.log('PASS bad records are refused, each with a stated reason');
}

// ── ZIP is optional, but a half-typed one is worse than none ────────────────
{
  assert.equal(validateWaitlistInput(VALID).value.zip, null,
    'no ZIP must be allowed — the owner knows a name and city long before five digits');
  assert.equal(validateWaitlistInput({ ...VALID, zip: '78704' }).value.zip, '78704', 'a real ZIP must be kept');
  assert.equal(validateWaitlistInput({ ...VALID, zip: '787' }).ok, false,
    'a partial ZIP must be refused: it would silently fail the dispatch test and read as "we cannot serve them"');
  assert.ok(migration.includes("CHECK (zip IS NULL OR zip ~ '^[0-9]{5}$')"),
    'the database must enforce the same ZIP shape as the validator');
  console.log('PASS ZIP is optional, and never half-stored');
}

// ── Provenance: demand signal must not look like a to-do list ───────────────
{
  assert.equal(WAITLIST_SOURCE.OWNER_ADDED, 'owner_added');
  assert.ok(ownerFn.includes('WAITLIST_SOURCE.OWNER_ADDED'), 'owner-added rows must be marked as such');
  assert.ok(publicFn.includes('WAITLIST_SOURCE.PUBLIC_FORM'), 'public signups must be marked as such');
  assert.ok(migration.includes("CHECK (source IN ('public_form', 'owner_added'))"),
    'the database must constrain source to the two real origins');

  // Provenance is written once: a genuine public signup must not be relabelled
  // if the owner later re-adds the same person by hand.
  assert.ok(core.includes('const { source: _ignoredSource, ...mutable } = record'),
    'updating an existing waitlist row must never rewrite where that person came from');

  assert.ok(ui.includes("w.source === 'owner_added'"),
    'the dashboard must show which names the owner added, or a to-do list reads as demand');
  console.log('PASS a signup and an owner-added name stay distinguishable');
}

// ── Emailing someone who never contacted us is opt-in ───────────────────────
{
  assert.ok(ownerFn.includes('req.body.sendConfirmation === true'),
    'the confirmation email must require an explicit true — a default-on cold email is the failure mode here');
  assert.ok(ownerFn.includes('easer_waitlist_owner_added'),
    'an owner-added person must be logged under their own notification type');
  console.log('PASS an owner-added person is emailed only on purpose');
}

// ── One email, two honest variants ─────────────────────────────────────────
// Someone who signs up and someone the owner adds get the SAME email. A person
// must not be able to tell which door they came through, and neither version
// should look like the cheaper one.
{
  const signup = buildWaitlistEmail({ name: 'Marcus Webb', city: 'Round Rock', state: 'TX', variant: 'signup' });
  const added = buildWaitlistEmail({ name: 'Marcus Webb', city: 'Round Rock', state: 'TX', variant: 'owner_added' });

  // The shell is shared, so the design cannot drift between them.
  for (const part of ['ON WAITLIST', 'What Happens Next', 'Why Professionals Choose Us', 'Visit AssembleAtEase', 'images/logo.jpg']) {
    assert.ok(signup.html.includes(part), `the signup email must keep ${part}`);
    assert.ok(added.html.includes(part), `the owner-added email must have the same ${part} as a real signup`);
  }
  assert.ok(!/\$\{/.test(signup.html) && !/\$\{/.test(added.html), 'no unfilled placeholders may ship');

  // Article 16: the three sentences that would be false for someone who never
  // filled in a form — and the last one is the one a recipient actually reads
  // when working out why a company is emailing them.
  assert.ok(/signed up for the AssembleAtEase assembler waitlist/.test(signup.html),
    'a real signup should still be told they signed up');
  assert.ok(!/signed up/i.test(added.html),
    'an owner-added person must never be told they signed up');
  assert.ok(!/thank you for your interest/i.test(added.html),
    'an owner-added person must not be thanked for interest they never expressed');
  assert.ok(/we added you to the AssembleAtEase Easer waitlist after speaking with you/i.test(added.html),
    'the owner-added email must say plainly why they are receiving it');
  assert.ok(/reply to this email and we will remove you/i.test(added.html),
    'the owner-added email must give the recipient a way out, because they did not opt in');

  // An unknown variant must fall back to the wording that is true either way.
  const unknown = buildWaitlistEmail({ name: 'Marcus Webb', city: 'Round Rock', state: 'TX', variant: 'nonsense' });
  assert.ok(!/signed up/i.test(unknown.html),
    'an unrecognised variant must never claim a signup that may not have happened');
  console.log('PASS both doors send the same email, and only the untrue sentences differ');
}

// ── A duplicate is reported, not silently overwritten ───────────────────────
{
  assert.ok(ownerFn.includes('ALREADY_ON_WAITLIST'),
    'adding someone already on the list must say so rather than quietly updating their row');
  console.log('PASS an existing entry is reported instead of overwritten');
}

// ── The ZIP rule has one owner, and the dashboard is not it ─────────────────
{
  assert.ok(ownerFn.includes('isAutomaticDispatchZip'), 'coverage must be decided by the source-of-truth helper');
  assert.ok(ui.includes('w.inDispatchArea'), 'the dashboard must render the server verdict');
  assert.ok(!/AUTOMATIC_DISPATCH_ZIPS/.test(ui),
    'the dashboard must not carry its own copy of the dispatch ZIP list (Article 4)');
  console.log('PASS coverage is a server verdict the page only renders');
}

// ── Deploy order must not be able to break the public form ─────────────────
// Migration 082 adds source and zip. If the code ships first, naming them in a
// write would make PostgREST reject the whole statement — taking down the
// PUBLIC waitlist form, which the owner is not watching, for a feature they
// were not using yet. That exact shape (correct logic, absent column, silent
// failure) cost this platform twelve hours once already.
{
  assert.ok(core.includes("const OPTIONAL_COLUMNS = ['source', 'zip']"),
    'the columns migration 082 adds must be named in one place');
  assert.ok(core.includes('isMissingColumnError(insertError, OPTIONAL_COLUMNS)'),
    'a waitlist insert must survive the migration not having run yet');
  assert.ok(core.includes('isMissingColumnError(updateError, OPTIONAL_COLUMNS)'),
    'a waitlist update must survive the migration not having run yet');
  assert.ok(core.includes("error.code === '42703' || error.code === 'PGRST204'"),
    'both the Postgres and PostgREST missing-column codes must be recognised');
  // Degrading quietly would be its own defect: the owner would type a ZIP, be
  // told the person is "in the dispatch area", and have neither stored.
  assert.ok(core.includes('degraded: degradedInsert'),
    'saveWaitlistRecord must report when it dropped columns');
  assert.ok(ownerFn.includes('saved.degraded ? null :'),
    'coverage must not be asserted for a ZIP that was silently dropped (Article 16)');
  console.log('PASS a signup still saves if migration 082 has not run yet, and says what it dropped');
}

// ── The page never invents a cause ──────────────────────────────────────────
{
  assert.ok(ui.includes("j.error || 'Could not add this person, and the server did not say why.'"),
    'a failed add must show the server reason, or admit the reason is unknown (Article 16)');
  console.log('PASS a failed add reports the real reason or says it is unknown');
}

console.log('\nOwner waitlist add tests passed.');
