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
  findJustifyingCopy,
  JUSTIFYING_PHRASES,
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

// ── Copy must not argue with the reader ─────────────────────────────────────
for (const plain of [
  'Your Easer is on the way.',
  'We placed a hold on your card. Nothing has been taken.',
  'Cancelling now carries the reschedule cancellation fee.',
  'We email you when it is sent.',
]) {
  assert.deepEqual(findJustifyingCopy(plain), [], `false positive on plain copy: ${plain}`);
}
for (const preachy of [
  'That window is there so a refund or a dispute is settled before money moves.',
  'Because this booking was rescheduled, a later cancellation incurs a fee.',
  'We hold the payout for 24 hours to ensure disputes are settled first.',
  'Please note that your card will not be charged today.',
]) {
  assert.ok(findJustifyingCopy(preachy).length > 0, `missed self-justifying copy: ${preachy}`);
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
    const recipientExpr = (block.match(/\b(?:to|recipient)\s*:\s*([^,\n]+)/) || [])[1] || '';
    const goesToOwner = /ownerEmail\(\)/.test(recipientExpr);
    // Labelled at all, versus labelled with a value we can classify here. A
    // dynamic `recipientType: recipient.type` is a real label — the send is
    // attributable at runtime — it simply cannot be sorted into customer or
    // Easer copy rules from source, so it is exempt from those, not from this.
    const labelled = /recipientType\s*:/.test(block);
    const who = block.match(/recipientType:\s*'([a-z_]+)'/);

    // Not every match is a send site. The shared modules ARE the send function,
    // and several callers inject it (`email = options => sendEmail(options)`)
    // or fan out a payload built elsewhere. Those forward someone else's meta;
    // the label belongs at the real call, which this loop reaches separately.
    const forwards = !recipientExpr
      || /^\s*(options|message|payload|body)\s*$/.test(recipientExpr)
      || /=>\s*send/.test(src.slice(Math.max(0, call.index - 60), call.index));
    const sharedModule = /[\\/]_[a-z-]+\.js$/.test(file);
    // A meta built above the call (`meta` shorthand, or `meta: someVar`) is
    // still a label; it just is not written inline.
    const metaByReference = /\bmeta\s*[,}]/.test(block) || /meta:\s*[A-Za-z_$][\w$]*\s*[,}]/.test(block);

    // An unlabelled send is not merely badly logged — it is INVISIBLE to every
    // check below, because they all key on recipientType. That is how
    // "Your existing payment authorization has not changed; capture occurs
    // only after completion" sat in a customer email while this guard passed.
    // Anything not addressed to the owner must say who it is for.
    if (!labelled && !goesToOwner && !forwards && !sharedModule && !metaByReference) {
      failures.push(`${relative(ROOT, file)}:${src.slice(0, call.index).split('\n').length} sends to "${recipientExpr.trim()}" with no recipientType — an unlabelled send escapes every copy rule here`);
      continue;
    }
    if (!who || !['customer', 'easer'].includes(who[1])) continue;
    // Only string literals; identifiers and object keys are not copy.
    const literals = block.match(/`[^`]*`|'[^']*'|"[^"]*"/g) || [];
    const line = src.slice(0, call.index).split('\n').length;
    for (const literal of literals) {
      // The jargon map is customer-only. An Easer genuinely HAS a payout and is
      // dispatched to jobs; banning those words for them would be false.
      if (who[1] === 'customer') {
        for (const hit of findCustomerLanguageViolations(literal)) {
          failures.push(`${relative(ROOT, file)}:${line} says "${hit.term}" to a customer — say ${hit.say}`);
        }
      }
      // Arguing the rule is wrong for both. Say what happened and what to do.
      for (const hit of findJustifyingCopy(literal)) {
        failures.push(`${relative(ROOT, file)}:${line} explains itself to the ${who[1]} with "${hit.phrase}" — cut the reason, keep the fact: "${hit.sentence}"`);
      }
    }
  }
}

// ── Customer pages the SERVER renders ───────────────────────────────────────
// The first version of this guard checked emails plus track.html and book.html
// and called that the customer surface. It was not. The secure card page is
// built as a string inside api/booking/payment-recovery.js, so it was never
// scanned, and it told people their card would be "authorized now and captured
// after completed work" and that "a disclosed late-cancellation fee may apply"
// — on the one page where someone types a card number. Anything served as HTML
// to a customer counts, wherever it is built.
for (const file of await jsFiles(join(ROOT, 'api'))) {
  const src = await readFile(file, 'utf8');
  if (!/<!doctype html|<!DOCTYPE html/.test(src)) continue;
  if (!/res\.(?:send|status\(\d+\)\.send)|text\/html/.test(src)) continue;
  // The owner has his own served pages; they may use the real terms.
  if (/[\/]owner[\/]/.test(file) && !/quote-approve/.test(file)) continue;
  // A served page puts half its words in its own <script>: status lines
  // assigned to textContent and thrown Error messages. visibleCustomerText
  // strips script blocks, so "Authorizing securely..." and "Authorization
  // complete" sat on the card page unseen. Pull those strings out too.
  for (const [, msg] of src.matchAll(/(?:textContent|innerHTML)\s*=\s*'([^']{12,})'/g)) {
    for (const hit of findCustomerLanguageViolations(msg)) {
      failures.push(`${relative(ROOT, file)} shows "${hit.term}" in a page message — say ${hit.say}`);
    }
  }
  for (const [, msg] of src.matchAll(/new Error\(\s*'([^']{12,})'\s*\)/g)) {
    for (const hit of findCustomerLanguageViolations(msg)) {
      failures.push(`${relative(ROOT, file)} throws "${hit.term}" at a customer — say ${hit.say}`);
    }
  }
  for (const page of src.match(/`[^`]{120,}`/g) || []) {
    if (!/<!doctype html/i.test(page)) continue;
    for (const hit of findCustomerLanguageViolations(page)) {
      failures.push(`${relative(ROOT, file)} serves a page saying "${hit.term}" to a customer — say ${hit.say}`);
    }
    for (const hit of findJustifyingCopy(page)) {
      failures.push(`${relative(ROOT, file)} serves a page that explains itself with "${hit.phrase}" — keep the fact: "${hit.sentence}"`);
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

console.log(`PASS customer language: ${CUSTOMER_FORBIDDEN_TERMS.length} banned terms on customer surfaces, ${JUSTIFYING_PHRASES.length} self-justifying phrases on customer and Easer surfaces`);
