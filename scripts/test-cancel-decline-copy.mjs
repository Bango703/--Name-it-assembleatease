#!/usr/bin/env node
// Cancel and decline emails (owner, 2026-10-23, after checking the research):
// one apology, thanks rather than a second apology, a way back to booking, and
// the customer's first name. A cancellation that charged a fee does not
// apologize in the same breath as the charge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  const cancel = read('api/booking/cancel.js');
  assert.match(cancel, /const apologyHtml = feeCaptured > 0\n      \? ''\n      : `<p[^`]*>We're sorry this one didn't work out\.<\/p>`;/, 'apology only when no fee was charged');
  assert.match(cancel, /headline: `Your booking has been cancelled, \$\{esc\(firstName\)\}\.`/, 'greets by first name');
  assert.match(cancel, /\$\{apologyHtml\}/);
  assert.match(cancel, />Book again<\/a>/, 'a way back to booking');
  assert.match(cancel, /const rebookUrl = `\$\{SITE\}\/book\$\{REBOOK_SERVICES\.has\(booking\.service\)/, 'the button opens the same service when /book knows it');
  assert.doesNotMatch(cancel, /please don't hesitate to reach out/);
}
console.log('PASS cancel email: first name, apology only without a fee, Book again');

{
  const decline = read('api/booking/decline.js');
  assert.match(decline, /headline: `We're sorry, \$\{esc\(firstName\)\}\. We can't take this one\.`/);
  assert.doesNotMatch(decline, /We apologize for any inconvenience/, 'one apology, not two');
  assert.doesNotMatch(decline, /Unfortunately we are not able/);
  assert.match(decline, /Thank you for your understanding\./, 'thanks instead of a second apology');
  assert.match(decline, />Book again<\/a>/);
}
console.log('PASS decline email: one apology, thanks, Book again, first name');
