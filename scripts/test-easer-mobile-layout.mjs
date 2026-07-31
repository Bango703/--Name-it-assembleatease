import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const jobsUi = await readFile(new URL('../assembler/my-assignments.html', import.meta.url), 'utf8');

assert.match(jobsUi, /html, body \{ max-width: 100%; overflow-x: hidden; \}/);
assert.match(jobsUi, /body\.theme-pro \.modal-box \{[\s\S]*max-width: 100vw;[\s\S]*overflow-x: hidden;/);
assert.match(jobsUi, /\.e-job-card-top \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/);
assert.match(jobsUi, /overflow-wrap: anywhere;/);
assert.match(jobsUi, /\.asgn-detail-header \{/);
assert.match(jobsUi, /class="asgn-detail-title"/);
assert.match(jobsUi, /class="sb asgn-detail-status /);
assert.match(jobsUi, /@media \(max-width: 520px\)/);
assert.match(jobsUi, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(jobsUi, /\.asgn-detail-header,[\s\S]*\.e-job-card-top \{ grid-template-columns: minmax\(0, 1fr\); \}/);

console.log('Easer narrow-mobile layout containment tests: PASS');
