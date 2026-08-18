#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [book, apply, owner] = await Promise.all([
  read('book.html'),
  read('assembler/apply.html'),
  read('owner/index.html'),
]);

// Customer: value first, truthful plan, and no fabricated pressure.
assert.match(book, /Step 1 of 4 &mdash; Job plan/);
assert.match(book, /id="job-plan-preview"/);
assert.match(book, /id="job-plan-ready"/);
assert.match(book, /function renderJobPlanCards\(\)/);
assert.match(book, /var snapshot = getPricingSnapshot\(BOOK\.zip \|\| ''\)/);
assert.match(book, /We&rsquo;ll verify the final price and availability before your booking is confirmed/);
assert.doesNotMatch(book, /Slots filling up fast/i);
assert.doesNotMatch(book, /urgency-scarce/);
assert.match(book, /isPublishedSlotAvailable\(BOOK\.date, slot\)/);
assert.match(book, /slot-rec">Earliest available/);
assert.match(book, /if \(!BOOK\.time\)[\s\S]*firstAvail/);
assert.doesNotMatch(book, /id="s1-quote"[^>]*checked/i);
assert.doesNotMatch(book, /id="s5-terms"[^>]*checked/i);

// Easer: concrete offer value appears before the form; progress advances only
// from real field groups, while all consent and capability choices stay manual.
const valuePreviewIndex = apply.indexOf('class="easer-value-preview"');
const formIndex = apply.indexOf('<form id="apply-form">');
assert.ok(valuePreviewIndex > 0 && valuePreviewIndex < formIndex, 'Easer value preview must appear before the application form');
assert.match(apply, /See the job details, service area, schedule, and your estimated payout/);
assert.match(apply, /1 of 5 steps complete/);
assert.match(apply, /Application started\. Next: complete your profile and contact details/);
assert.match(apply, /var completed = 1 \+ \[profileDone, servicesDone, readinessDone, agreementDone\]/);
assert.match(apply, /var servicesDone = !!document\.querySelector\('#services-grid input:checked'\)/);
assert.match(apply, /var readinessDone = !!document\.querySelector\('input\[name="transport"\]:checked'\)/);
assert.match(apply, /document\.getElementById\('contractor-agree'\)\.checked/);
assert.match(apply, /document\.getElementById\('fee-consent'\)\.checked/);
for (const consentId of ['contractor-agree', 'conduct', 'fee-consent']) {
  const tag = apply.match(new RegExp(`<input[^>]+id="${consentId}"[^>]*>`, 'i'))?.[0] || '';
  assert.ok(tag, `${consentId} input is required`);
  assert.doesNotMatch(tag, /\bchecked\b/i, `${consentId} must not be prechecked`);
}
for (const serviceTag of apply.match(/<input type="checkbox" value="[^"]+"[^>]*>/g) || []) {
  assert.doesNotMatch(serviceTag, /\bchecked\b/i, 'Easer capabilities must not be preselected');
}

// Owner: one explained recommendation is selected from existing safe buttons.
// Refund and cancellation remain available only as deliberate secondary actions.
assert.match(owner, /function renderOwnerActionCollection\(notices, btns\)/);
assert.match(owner, /Recommended next action/);
const priorityBlock = owner.match(/var actionPriority = \[([\s\S]*?)\];/)?.[1] || '';
assert.ok(priorityBlock, 'Owner action priority list is missing');
assert.doesNotMatch(priorityBlock, /['"](?:refund|refund-manual-payment|cancel|decline)['"]/);
assert.match(owner, /'record-manual-payment'/);
assert.match(owner, /'reconcile-payment'/);
assert.match(owner, /'damage-review'/);
assert.match(owner, /'payout'/);
assert.match(owner, /renderOwnerActionCollection\(notices, btns\)/);
assert.match(owner, /data-action="refund"/);
assert.match(owner, /data-action="cancel"/);

// Mobile containment for every new component.
assert.match(book, /@media \(max-width:520px\)[\s\S]*\.job-plan-meta\{grid-template-columns:1fr\}/);
assert.match(apply, /@media \(max-width: 980px\)[\s\S]*\.easer-value-preview \{ grid-template-columns: 1fr; \}/);
assert.match(owner, /\.owner-next-action\{align-items:stretch;flex-direction:column\}/);

console.log('Behavioral UX flow checks passed');
