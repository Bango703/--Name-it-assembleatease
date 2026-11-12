#!/usr/bin/env node
// Easer recruiting pages (owner, 2026-11-12: "add everything that needs to be
// added and fix; make it look smooth, rather than a bunch of block sections").
// Every number comes from its source, nothing is promised that is not true,
// and the layout stays open sections rather than stacked bordered cards.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { getPlatformFeePct, SERVICE_CALL_ZONES } from '../api/_source-of-truth.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hub = read('become-an-easer.html');
const houston = read('easer-jobs-houston-tx.html');
const cityPages = readdirSync(new URL('..', import.meta.url)).filter((f) => /^easer-jobs-[a-z-]+-tx\.html$/.test(f));
assert.equal(cityPages.length, 54);

// Pay examples equal the catalog price plus the service fee, at the Easer share.
{
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(read('assets/js/booking-source-of-truth.js'), context);
  const items = [];
  JSON.stringify(context.window.AAE_BOOKING_SOURCE, (k, v) => { if (v && typeof v.name === 'string' && typeof v.price === 'number') items.push(v); return v; });
  const share = 100 - getPlatformFeePct(false);
  const fee = SERVICE_CALL_ZONES.austin_core.fee;
  const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
  for (const name of ['TV 56"–65" (standard wall)', 'Treadmill assembly', 'Swing set / backyard playset assembly']) {
    const item = items.find((i) => i.name === name);
    assert.ok(item, name);
    const job = Math.round(item.price * 100) + fee;
    const earn = Math.round(job * share / 100);
    for (const [label, page] of [['hub', hub], ['Houston', houston]]) {
      assert.ok(!page.includes('Customer price'), `${label}: the customer's price is not shown`);
      assert.ok(page.includes(`<small>You earn</small>${money(earn)}`), `${label}: ${name} Easer pay ${money(earn)}`);
    }
  }
  assert.ok(hub.includes(`Keep ${share}% plus tips`));
  assert.ok(hub.includes('Tips are 100% yours.'));
}
console.log('PASS pay: examples are catalog prices plus the service fee at the Easer share, on every page');

// Only true statements.
{
  for (const f of ['become-an-easer.html', ...cityPages]) {
    const page = read(f);
    assert.doesNotMatch(page, /no fees to apply|No application fee for founding/i, `${f}: fee promises follow the per-hub rule`);
    assert.match(page, /No application fee while your area is adding Easers/, `${f}: fee line`);
    assert.doesNotMatch(page, /actively booking across the Austin metro/, `${f}: booking is statewide`);
    assert.match(page, /strongly recommended\. AssembleAtEase does not provide insurance for contractors\./, `${f}: insurance answer matches agreement section 10`);
    assert.match(page, /Instant payout is available when your bank supports it\./, `${f}: instant payout only where Stripe allows it`);
  }
  for (const hubSlug of ['austin', 'houston', 'san-antonio', 'dallas']) assert.match(hub, new RegExp(`<a href="/easer-jobs-${hubSlug}-tx">`));
  assert.match(hub, /<details class="rec-more">\s*<summary>See every Texas city<\/summary>/, 'the full city list is folded away');
}
console.log('PASS copy: per-hub fee, statewide booking, insurance and payouts as the agreement and Stripe allow');

// Smooth layout: open sections, one hub photo, no stacked bordered cards.
{
  for (const f of ['become-an-easer.html', ...cityPages]) {
    const page = read(f);
    assert.doesNotMatch(page, /class="rec-card"|class="rec-grid"/, `${f}: no card grid`);
    assert.match(page, /<ol class="rec-steps">/, `${f}: steps timeline`);
    assert.match(page, /<ul class="rec-pay">/, `${f}: pay rows`);
    assert.match(page, /<div class="rec-faq">\s*<details>/, `${f}: FAQ as disclosure rows`);
  }
  assert.match(hub, /<img src="\/images\/real-outdoor-patio-gray\.jpg"/, 'hub uses a real job photo');
  assert.doesNotMatch(houston, /<figure class="rec-hero-photo"/, 'city pages carry no photo (no reused images)');
  const gen = read('scripts/generate-easer-recruit-pages.js');
  assert.match(gen, /import \{ getPlatformFeePct, SERVICE_CALL_ZONES \} from '\.\.\/api\/_source-of-truth\.js';/);
  assert.match(gen, /if \(!found\) throw new Error\(`Pay example item not in the catalog/);
}
console.log('PASS layout: open sections, steps timeline, pay rows, one real photo on the hub');

// Apply page fixes.
{
  const apply = read('assembler/apply.html');
  assert.match(apply, /<img src="\/images\/real-outdoor-sectional\.webp"/, 'real job photo');
  assert.match(apply, /\.hero-photo > img \{/, 'the photo rule no longer stretches the badge logo');
  assert.doesNotMatch(apply, /\.hero-photo img \{/);
  assert.match(apply, /id="phone" class="form-control" placeholder="\(512\) 555-0123"/, 'example number, not the business line');
  assert.doesNotMatch(apply, /launch-program status/);
  assert.match(apply, /&copy; 2026 AssembleAtEase LLC/);
  assert.doesNotMatch(apply, /\.easer-value-item \{[^}]*background:/, 'the three hero notes are an open list, not boxes');
}
console.log('PASS apply page: real photo, badge logo visible, example phone, current wording, LLC footer, open list');

console.log('\nEaser recruit page tests passed.');
