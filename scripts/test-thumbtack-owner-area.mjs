import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { centsValue, leadSummary, validBasicAuth } from '../api/webhooks/thumbtack.js';

const migration = await readFile(new URL('../api/migrations/122_thumbtack_owner_area.sql', import.meta.url), 'utf8');
const ownerApi = await readFile(new URL('../api/owner/thumbtack.js', import.meta.url), 'utf8');
const webhook = await readFile(new URL('../api/webhooks/thumbtack.js', import.meta.url), 'utf8');
const ownerUi = await readFile(new URL('../owner/assets/thumbtack.js', import.meta.url), 'utf8');
const ownerPage = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

assert.equal(centsValue({ leadPriceInCents: 950 }), 950, 'explicit cents fields remain cents at small amounts');
assert.equal(centsValue({ leadPrice: 18.94 }), 1894, 'decimal lead price converts from dollars');
assert.equal(centsValue({ leadPrice: { amountInCents: 1250 } }), 1250, 'nested amountInCents remains cents');
assert.equal(centsValue({ leadPrice: 18 }), null, 'ambiguous whole-number lead prices remain unknown');
assert.equal(centsValue({ leadPrice: -1 }), null, 'negative costs are rejected');
assert.deepEqual(leadSummary({ request: { category: { name: 'Furniture Assembly' }, location: { city: 'Austin', state: 'TX' }, description: 'Two bed frames' } }), {
  service: 'Furniture Assembly', city: 'Austin', state: 'TX', description: 'Two bed frames',
}, 'Thumbtack V4 request fields are mapped from the documented lead shape');
const goodBasic = 'Basic ' + Buffer.from('aae-user:a-long-random-secret').toString('base64');
assert.equal(validBasicAuth(goodBasic, 'aae-user', 'a-long-random-secret'), true);
assert.equal(validBasicAuth(goodBasic, 'aae-user', 'wrong-secret'), false);
assert.equal(validBasicAuth('Bearer a-long-random-secret', 'aae-user', 'a-long-random-secret'), false);

assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
assert.match(migration, /REVOKE ALL ON public\.thumbtack_leads, public\.thumbtack_webhook_events FROM PUBLIC, anon, authenticated/i);
assert.match(migration, /ON CONFLICT \(event_key\) DO NOTHING/i, 'webhook persistence is idempotent');
assert.match(migration, /thumbtack_leads_booking_unique_idx/i, 'one AAE job cannot inflate returns across multiple leads');
assert.match(webhook, /validBasicAuth\(req\.headers\?\.authorization/);
assert.match(webhook, /record_thumbtack_webhook_event_v1/);
assert.doesNotMatch(webhook, /p_payload\s*:/, 'raw webhook payloads are not persisted');
assert.match(ownerApi, /if \(!verifyOwner\(req\)\)/);
assert.match(ownerApi, /external_platform !== 'thumbtack'/, 'only Thumbtack-originated bookings may be linked');
assert.match(ownerApi, /platformRevenue/);
assert.match(ownerApi, /netLeadCostCents/);
assert.match(ownerApi, /not_converted/);
assert.match(ownerApi, /is_test_booking === true/, 'test bookings cannot be linked as real lead returns');
assert.match(ownerApi, /select\('id,external_platform,is_test_booking'\)/, 'the test-booking guard uses a selected database field');
assert.match(ownerUi, /data-refund/);
assert.match(ownerUi, /data-credit/);
assert.match(ownerUi, /data-outcome/);
assert.match(ownerUi, /esc\(lead\.latest_message_preview\)/, 'message text is HTML escaped');
assert.match(ownerPage, /data-view="thumbtack"/);
assert.match(ownerPage, /id="thumbtack-view"/);

console.log('PASS: Thumbtack owner area auth, event idempotency, privacy boundary, and reporting wiring');
