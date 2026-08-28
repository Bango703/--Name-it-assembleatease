#!/usr/bin/env node

/**
 * A customer must never see an Easer's legal name on their card statement.
 *
 * Stripe defaults a connected account's statement descriptor to the individual's
 * legal name, so tips would have appeared as "TRAPPER A RINEY" or "TRAVIS
 * GIBSON". Someone who does not recognise a personal name on their statement does
 * not call to ask — they file a chargeback, and on a direct charge that lands on
 * the EASER's account, not the platform's.
 *
 * The three existing accounts were corrected by hand on 2026-08-28. This makes
 * sure the next one is never wrong in the first place.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const src = await fs.readFile(new URL('../api/assembler/connect-link.js', import.meta.url), 'utf8');

{
  const at = src.indexOf('stripe.accounts.create(');
  assert.ok(at > -1, 'Connect accounts must still be created here');
  const call = src.slice(at, src.indexOf('});', at));

  assert.ok(/statement_descriptor: 'ASSEMBLEATEASE TIP'/.test(call),
    'account creation must set the statement descriptor, or Stripe defaults it to the Easer\'s legal name');

  const value = /statement_descriptor: '([^']+)'/.exec(call)[1];
  assert.ok(value.length >= 5 && value.length <= 22,
    `Stripe allows 5-22 characters; "${value}" is ${value.length}`);
  assert.ok(!/[<>\\"']/.test(value), 'Stripe rejects < > \ " \' in a statement descriptor');
  assert.ok(/assembleatease/i.test(value),
    'the descriptor must name the BUSINESS the customer booked with, not the individual');
  console.log(`PASS every new Easer onboards with "${value}" facing customers`);
}

console.log('\nConnect statement descriptor test passed.');
