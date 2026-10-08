import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = fs.readFileSync(path.join(root, 'api', '_notification-policy.js'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'api', 'migrations', '096_notification_delivery_policy.sql'), 'utf8');
const inventory = new Set(fs.readFileSync(path.join(root, 'docs', 'platform', '12-NOTIFICATION-TYPE-INVENTORY.txt'), 'utf8')
  .split(/\r?\n/).map(value => value.trim()).filter(Boolean));

const callerTypes = new Set();
const apiRoot = path.join(root, 'api');
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/notificationType\s*:\s*['"]([^'"]+)['"]/g)) callerTypes.add(match[1]);
    }
  }
}
walk(apiRoot);

const missingFromInventory = [...callerTypes].filter(type => !inventory.has(type)).sort();
assert.deepEqual(missingFromInventory, [], `Notification types missing from inventory: ${missingFromInventory.join(', ')}`);

const routineBlock = policy.match(/const ROUTINE = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(routineBlock, 'Could not find JavaScript ROUTINE notification set');
const jsRoutine = new Set([...routineBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
jsRoutine.add('broadcast');

const sqlBlock = sql.match(/n\.notification_type IN \(([^)]*)\)/);
assert.ok(sqlBlock, 'Could not find SQL routine notification list');
const sqlRoutine = new Set([...sqlBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
assert.deepEqual([...jsRoutine].sort(), [...sqlRoutine].sort(), 'JavaScript and SQL routine notification classifications differ');

console.log(`notification taxonomy parity: PASS (${callerTypes.size} caller types, ${inventory.size} inventory types)`);
