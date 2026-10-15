#!/usr/bin/env node
// operational_events.request_id is NOT NULL with no default. On 2026-10-15 seven
// callers inserted without it; every row was refused, nobody saw the refusal, and
// the stranded-booking alert, which reads its own past rows to stay quiet, sent
// the owner the same four bookings 39 times in 20 hours.
//
// What must hold:
//   - nothing in api/ inserts into operational_events directly unless it sets
//     request_id itself; everything else goes through recordOperationalEvents
//     or insertOperationalEventFailOpen, which fill it;
//   - a refused row is reported as refused, never as success.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { recordOperationalEvents, insertOperationalEventFailOpen } from '../api/_observability.js';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk('api')) {
  if (file.split('\\').join('/').endsWith('api/_observability.js')) continue;
  const src = readFileSync(file, 'utf8');
  const re = /from\('operational_events'\)\s*\.(insert|upsert)\(/g;
  let m;
  while ((m = re.exec(src))) {
    const window = src.slice(Math.max(0, m.index - 1500), m.index + 600);
    if (!/request_id\s*:/.test(window)) offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
  }
}
assert.deepEqual(offenders, [], `Direct operational_events writes without request_id: ${offenders.join(', ')}`);

// A stand-in that refuses rows the way Postgres does.
function table() {
  const rows = [];
  return {
    rows,
    from() {
      return {
        async insert(input) {
          const list = Array.isArray(input) ? input : [input];
          if (list.some(r => !r.request_id)) return { error: { message: 'null value in column "request_id" violates not-null constraint' } };
          rows.push(...list);
          return { error: null };
        },
      };
    },
  };
}
const quiet = { error() {}, warn() {} };

const sb = table();
const one = await recordOperationalEvents(sb, { event_type: 'stranded_booking_alert', route: '/x', method: 'CRON', actor_role: 'cron', payload: { refs: ['AAE-1'] } }, { logger: quiet });
assert.equal(one.ok, true);
assert.ok(sb.rows[0].request_id, 'request_id is filled');
assert.deepEqual(sb.rows[0].payload, { refs: ['AAE-1'] }, 'the payload the alert reads back is kept as given');
const many = await recordOperationalEvents(sb, [{ event_type: 'a', route: '/x', method: 'CRON', actor_role: 'cron' }, { event_type: 'b', route: '/x', method: 'CRON', actor_role: 'cron' }], { logger: quiet });
assert.equal(many.ok, true);
assert.notEqual(sb.rows[1].request_id, sb.rows[2].request_id, 'each row gets its own request_id');

const refusing = { from() { return { async insert() { return { error: { message: 'refused' } }; } }; } };
const refused = await recordOperationalEvents(refusing, { event_type: 'x', route: '/x', method: 'CRON', actor_role: 'cron' }, { logger: quiet });
assert.equal(refused.ok, false, 'a refused row is reported as refused');
assert.equal(await insertOperationalEventFailOpen(refusing, { event_type: 'x', route: '/x', method: 'CRON', actor_role: 'cron' }, { logger: quiet }), false,
  'the older helper no longer reports a refused row as written');
const sb2 = table();
assert.equal(await insertOperationalEventFailOpen(sb2, { event_type: 'x', route: '/x', method: 'CRON', actor_role: 'cron' }, { logger: quiet }), true);
assert.ok(sb2.rows[0].request_id, 'the older helper fills request_id too');

console.log('PASS operational event writes: every writer sets request_id, refused rows are reported, the alert can remember what it sent.');
