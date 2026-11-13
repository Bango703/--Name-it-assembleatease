#!/usr/bin/env node
// The repository's project knowledge stays navigable and dated (owner,
// 2026-11-13: Deep Execution, Persistent Knowledge & Context Efficiency
// Protocol). Fails when:
//   - docs/knowledge-index.md points at a file or folder that does not exist;
//   - docs/current-state.md or docs/work-in-progress.md lose their
//     "Last verified: YYYY-MM-DD" line;
//   - a decision or incident record exists that the index does not list;
//   - CLAUDE.md or AGENTS.md stop pointing agents at the index.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');
const exists = p => existsSync(new URL(p, root));

const index = read('docs/knowledge-index.md');
const referenced = [...index.matchAll(/`([^`\s]+)`/g)].map(m => m[1])
  .filter(p => /\.(md|ya?ml|txt|js|mjs|json)$/.test(p) && !p.includes('*'));
const resolved = referenced.map(p => (p.includes('/') || p === 'CLAUDE.md' || p === 'AGENTS.md') ? p : `docs/platform/${p}`);
const missing = resolved.filter(p => !exists(p));
assert.deepEqual(missing, [], 'every file in docs/knowledge-index.md exists');

for (const doc of ['docs/current-state.md', 'docs/work-in-progress.md']) {
  assert.match(read(doc), /^Last verified: \d{4}-\d{2}-\d{2}\./m, `${doc} carries its verification date`);
}

for (const folder of ['docs/decisions', 'docs/incidents', 'docs/business-rules']) {
  for (const name of readdirSync(new URL(folder + '/', root))) {
    if (!name.endsWith('.md')) continue;
    assert.ok(index.includes(`${folder}/${name}`), `docs/knowledge-index.md lists ${folder}/${name}`);
  }
}

assert.ok(exists('docs/process/deep-execution-protocol.md'));
assert.match(read('CLAUDE.md'), /docs\/knowledge-index\.md/, 'CLAUDE.md points agents at the knowledge index');
assert.match(read('AGENTS.md'), /docs\/knowledge-index\.md/, 'AGENTS.md points agents at the knowledge index');

console.log(`PASS knowledge index: ${resolved.length} referenced files exist; current state and work in progress are dated; every decision, incident and business rule is indexed.`);
