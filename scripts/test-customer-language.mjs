#!/usr/bin/env node
// Panel seat 15: no internal vocabulary reaches a customer.
//
// Seat 13 owns the colour token, so #5eead4 fails the build. Nothing owned the
// words, so "Your card is authorized, not charged. Payment is captured only
// after completed work" shipped, and so did "Upload failed (server said 502)".
// Both are true. Neither is readable by the person they were written for, and
// Article 16 only ever asked about the first thing.
//
// Scope is deliberate. Customer-addressed email, SMS and push, plus the visible
// copy on the customer pages. Owner surfaces are exempt: the owner dashboard is
// an operator console and needs the real terms.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  CUSTOMER_FORBIDDEN_TERMS,
  visibleCustomerText,
  findCustomerLanguageViolations,
} from '../api/_customer-language.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// ── The map itself must stay usable ─────────────────────────────────────────
assert.ok(CUSTOMER_FORBIDDEN_TERMS.length >= 15, 'the term map was gutted');
for (const rule of CUSTOMER_FORBIDDEN_TERMS) {
  assert.ok(rule.pattern instanceof RegExp && rule.say, 'every term needs a pattern and a replacement');
}

// Ordinary English must survive, or the guard gets deleted by the next person
// in a hurry rather than obeyed.
for (const safe of [
  'Avoid the stairs if you can.',
  'We will send a reminder the day before.',
  'Your Easer is on the way and will text you.',
  'Nothing has been charged yet.',
  'We placed a hold on your card.',
  'A second pro is joining your appointment.',
]) {
  assert.deepEqual(findCustomerLanguageViolations(safe), [],
    `false positive on ordinary copy: ${safe}`);
}

// And the real offenders must be caught.
for (const bad of [
  'Your card is authorized, not charged.',
  'Payment is captured after completed work.',
  'Your booking is in_progress.',
  'Upload failed (server said 502). HTTP error.',
  'Your payout is pending.',
  'The assembler will arrive soon.',
]) {
  assert.ok(findCustomerLanguageViolations(bad).length > 0, `missed: ${bad}`);
}

// Interpolations are values, not our words: ${booking.assembler_name} renders a
// person's name, and flagging it would train everyone to ignore this test.
assert.deepEqual(
  findCustomerLanguageViolations('Hi ${customerFirstName}, ${booking.assembler_name} is on the way.'),
  [],
  'a template interpolation is a value, not copy',
);
// Markup and its attributes are not read either.
assert.deepEqual(
  findCustomerLanguageViolations('<div id="stripe-card-element" class="capture"><p>You are all set.</p></div>'),
  [],
  'HTML attributes are not customer copy',
);
assert.equal(visibleCustomerText('<p>Hello</p>').trim(), 'Hello');

// ── Every customer-addressed notification ───────────────────────────────────
async function jsFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SENDERS = /\b(sendEmail|sendSms|sendPushToUser)\s*\(/g;
const failures = [];

/**
 * The text of one send call, from its opening paren to the paren that closes
 * it. Slicing a fixed window instead swept up whatever code happened to follow
 * — SELECT lists, other calls — and reported column names as customer copy.
 * That is exactly the noise that gets a guard switched off instead of obeyed.
 */
function callSource(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return src.slice(openParen, openParen + 8000);
}

for (const file of await jsFiles(join(ROOT, 'api'))) {
  const src = await readFile(file, 'utf8');
  for (const call of src.matchAll(SENDERS)) {
    const block = callSource(src, src.indexOf('(', call.index));
    const who = block.match(/recipientType:\s*'([a-z_]+)'/);
    if (!who || who[1] !== 'customer') continue;
    // Only string literals; identifiers and object keys are not copy.
    const literals = block.match(/`[^`]*`|'[^']*'|"[^"]*"/g) || [];
    for (const literal of literals) {
      for (const hit of findCustomerLanguageViolations(literal)) {
        const line = src.slice(0, call.index).split('\n').length;
        failures.push(`${relative(ROOT, file)}:${line} says "${hit.term}" to a customer — say ${hit.say}`);
      }
    }
  }
}

// ── Visible copy on the customer pages ──────────────────────────────────────
// "Secured by Stripe" is deliberately not a banned term: naming the processor
// is a trust signal the customer benefits from. The mechanics are what they
// never asked about.
for (const page of ['track.html', 'book.html']) {
  const src = await readFile(join(ROOT, page), 'utf8');
  for (const hit of findCustomerLanguageViolations(src)) {
    failures.push(`${page} shows "${hit.term}" to a customer — say ${hit.say}`);
  }
}

assert.deepEqual(failures, [], `internal vocabulary reached a customer:\n  ${failures.join('\n  ')}`);

console.log(`PASS customer language: ${CUSTOMER_FORBIDDEN_TERMS.length} terms enforced across customer email, SMS, push and pages`);
