#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const webhook = await fs.readFile(new URL('../api/assembler/stripe-webhook.js', import.meta.url), 'utf8');
const start = webhook.indexOf('function buildCustomerPaymentFailEmail');
assert.notEqual(start, -1, 'customer payment-failure email must exist');
const template = webhook.slice(start, webhook.indexOf('\n}', start) + 2);

assert.match(template, /Your booking wasn't completed/,
  'customer message should describe the incomplete booking without blaming the card');
assert.match(template, /you were not charged/,
  'customer must know that the failed checkout did not charge them');
assert.match(template, /href="https:\/\/www\.assembleatease\.com\/book"/,
  'customer must have a direct route to retry booking');
assert.match(template, />Try booking again</,
  'retry action must have a clear customer-facing label');
assert.doesNotMatch(template, /\$\{esc\(reason\)\}|Reason:|Klarna|different card/i,
  'customer email must not expose provider-specific failure reasons or prescribe a card');
assert.match(webhook, /buildOwnerPaymentFailEmail\(currentBooking, reason\)/,
  'the detailed failure reason must remain available to the owner');

console.log('PASS customer payment-failure email is calm, actionable, and provider-neutral');