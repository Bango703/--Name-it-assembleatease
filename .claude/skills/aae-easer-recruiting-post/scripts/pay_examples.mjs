#!/usr/bin/env node
// Current Easer pay for real catalog items, from the sources of truth the site
// uses (the same math as scripts/generate-easer-recruit-pages.js), plus the
// live application-fee answer for a ZIP. Run from the repo root:
//
//   node .claude/skills/aae-easer-recruiting-post/scripts/pay_examples.mjs 78745
//
// Prints JSON: { easerSharePct, serviceFeeCents, examples:[{item, earn}], fee }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const { getPlatformFeePct, SERVICE_CALL_ZONES } = await import(join(root, 'api/_source-of-truth.js')).catch(() => import('file://' + join(root, 'api/_source-of-truth.js').replace(/\\/g, '/')));

const context = { window: {} };
vm.createContext(context);
vm.runInContext(readFileSync(join(root, 'assets/js/booking-source-of-truth.js'), 'utf8'), context);
const items = [];
JSON.stringify(context.window.AAE_BOOKING_SOURCE, (k, v) => {
  if (v && typeof v === 'object' && typeof v.name === 'string' && typeof v.price === 'number') items.push(v);
  return v;
});

const share = 100 - getPlatformFeePct(false);
const fee = SERVICE_CALL_ZONES.austin_core.fee;
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const pick = [
  'TV 56"–65" (standard wall)', 'Bed frame — king / cal king', 'Treadmill assembly',
  'Swing set / backyard playset assembly', 'Smart lock — deadbolt replacement', 'Bunk bed / loft bed',
];
const examples = pick.map((name) => {
  const item = items.find((i) => i.name === name);
  if (!item) return { item: name, missing: true };
  const job = Math.round(item.price * 100) + fee;
  return { item: name, earn: money(Math.round(job * share / 100)) };
});

let feeAnswer = null;
const zip = process.argv[2];
if (zip) {
  try {
    const r = await fetch(`https://www.assembleatease.com/api/assembler/application-fee-status?state=TX&zip=${encodeURIComponent(zip)}`);
    const d = await r.json();
    feeAnswer = d.applicationFee ? { zip, noFee: d.applicationFee.waiverAvailable === true, amount: d.applicationFee.amountDisplay } : { zip, error: d.error || 'no answer' };
  } catch (e) {
    feeAnswer = { zip, error: 'could not reach the site' };
  }
}

console.log(JSON.stringify({ easerSharePct: share, serviceFeeCents: fee, examples, fee: feeAnswer }, null, 2));
