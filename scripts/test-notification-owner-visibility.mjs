import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { notificationEventType, notificationNeedsAttention, notificationOwnerAction } from '../api/_notification-display.js';
import { formatNotifDescription } from '../api/booking/activity.js';

for (const [status, event] of [['deferred','notification_deferred'], ['uncertain','notification_uncertain'], ['cancelled','notification_cancelled'], ['queued','notification_queued'], ['provider_accepted','notification_accepted'], ['delivered','notification_delivered']]) {
  assert.equal(notificationEventType(status), event);
  assert.notEqual(notificationEventType(status), 'notification_sent');
}
assert.equal(notificationNeedsAttention('uncertain'), true);
assert.equal(notificationNeedsAttention('deferred'), false);
assert.match(notificationOwnerAction('uncertain'), /before any resend/);
assert.match(notificationOwnerAction('deferred'), /Sending is not yet confirmed/);
assert.match(notificationOwnerAction('cancelled'), /does not cancel the booking/);
for (const status of ['failed','uncertain','deferred','cancelled']) {
  const copy = formatNotifDescription({ notification_type: 'job_accepted', channel: 'sms', recipient_type: 'customer', status });
  assert.doesNotMatch(copy, /customer notified|confirmation notice sent/i);
}
assert.match(formatNotifDescription({ notification_type: 'reminder', channel: 'email', status: 'provider_accepted' }), /delivery not yet confirmed/);
assert.doesNotMatch(formatNotifDescription({ notification_type: 'reminder', channel: 'email', status: 'provider_accepted' }), /Telnyx/);

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const activitySource = await read('api/booking/activity.js');
const poisonedRows = ['deferred','uncertain','cancelled'].map((status, i) => ({
  id: `row-${i}`, channel: 'email', notification_type: 'reminder', recipient_type: 'customer',
  status, sent_at: '2026-09-23T15:00:00Z',
  send_payload: { secret: 'DO-NOT-EXPOSE-SEND-PAYLOAD' }, claim_token: 'DO-NOT-EXPOSE-CLAIM',
  booking_snapshot: { guest_mutation_token_hash: 'DO-NOT-EXPOSE-SNAPSHOT' },
}));
const requests = [];
const sandbox = vm.createContext({
  console, notificationEventType, notificationNeedsAttention, notificationOwnerAction,
  verifyOwner: req => req.authorized,
  getSupabase: () => ({ from(table) {
    requests.push(table);
    return {
      select(columns) { if (table === 'notification_log') assert.doesNotMatch(columns, /\*|send_payload|claim_token|booking_snapshot/); return this; },
      eq() { return this; },
      order() { return Promise.resolve({ data: table === 'notification_log' ? poisonedRows : [], error: null }); },
    };
  } }),
});
vm.runInContext(activitySource.replace(/^import [^\r\n]+;\r?$/gm, '').replace(/export default async function handler/, 'async function handler').replace(/^export /gm, '') + '\nglobalThis.handler = handler;', sandbox);
async function timeline(authorized = true) {
  const result = { status(code) { this.code = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
  await sandbox.handler({ method: 'GET', authorized, query: { bookingId: '12345678-1234-4234-8234-123456789012' } }, result);
  return result;
}
assert.equal((await timeline(false)).code, 401);
assert.equal(requests.length, 0);
const response = await timeline();
assert.equal(response.code, 200);
assert.deepEqual(response.body.activity.map(row => row.event_type), ['notification_deferred','notification_uncertain','notification_cancelled']);
assert.ok(response.body.activity.every(row => row.metadata.ownerAction));
assert.doesNotMatch(JSON.stringify(response.body), /DO-NOT-EXPOSE|send_payload|claim_token|booking_snapshot/);

// All browser-facing log readers must use a safe projection after migration 096.
for (const path of ['api/booking/activity.js', 'api/owner/live-ops.js', 'api/owner/cases.js', 'api/owner/email-usage-report.js', 'api/owner/voice-calls.js', 'api/owner/resend-booking-details.js', 'api/assembler/notifications.js']) {
  const source = await read(path);
  const selects = [...source.matchAll(/from\('notification_log'\)\s*\.select\('([^']+)'/g)];
  assert.ok(selects.length, `${path} log read is explicit and guarded`);
  for (const [, columns] of selects) assert.doesNotMatch(columns, /\*|send_payload|claim_token|booking_snapshot/, `${path} must never return outbox secrets`);
}
assert.match(await read('api/owner/live-ops.js'), /in\('status', \[[^\]]*'uncertain'/);

const emailUi = await read('owner/email.html');
for (const script of emailUi.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (script[1].trim()) new vm.Script(script[1]);
}
function extract(name) {
  const start = emailUi.indexOf(`  function ${name}(`);
  return emailUi.slice(start, emailUi.indexOf('\n  }', start) + 4);
}
const ui = vm.createContext({ esc: value => String(value).replace(/</g, '&lt;') });
vm.runInContext(extract('broadcastResultHtml') + '\n' + extract('broadcastTestText'), ui);
assert.match(ui.broadcastResultHtml({ sent: 1, deferred: 2, alreadySent: 3, failed: 4, notSent: 5 }), /Queued: 2/);
assert.match(ui.broadcastResultHtml({ sent: 1, deferred: 2 }), /Queued emails have not been sent yet/);
assert.match(ui.broadcastTestText({ ok: true, deferred: 1 }), /not been sent yet/);
assert.match(ui.broadcastTestText({ ok: true, alreadySent: 1 }), /No duplicate was sent/);
assert.doesNotMatch(ui.broadcastTestText({ ok: false, failed: 1 }), /Test sent to/);
const dashboard = await read('owner/index.html');
assert.match(dashboard, /Delivery needs review: /);
assert.match(dashboard, /a\.metadata\.ownerAction/);
// Execute the resend click branch with fake GET/POST calls: cancellation sends
// nothing, rapid second clicks do nothing, and uncertain retries keep identity.
const branchMarker = "    } else if (action === 'resend-booking-details') {";
const branchStart = dashboard.indexOf(branchMarker) + branchMarker.length;
const branchEnd = dashboard.indexOf("    } else if (action === 'mark-test'", branchStart);
assert.ok(branchStart > branchMarker.length && branchEnd > branchStart);
let allowSend = false, failPost = false, duplicate = false, uuidCalls = 0;
const resendCalls = [], toasts = [];
const resendUi = vm.createContext({
  bookingDetailsRequestIds: {}, encodeURIComponent, Date,
  headers: () => ({}), crypto: { randomUUID: () => 'fixture-uuid-' + ++uuidCalls },
  confirm: text => { assert.match(text, /Details last sent/); assert.match(text, /Recent customer notices/); return allowSend; },
  toast: (text, kind) => toasts.push({ text, kind }), showTrackLink() {},
  fetch: async (url, options) => {
    resendCalls.push({ url, options });
    if (options.method === 'POST' && failPost) throw new Error('Timeout after acceptance');
    return { ok: true, json: async () => options.method === 'POST'
      ? { sentTo: 'customer@example.test', alreadySent: duplicate }
      : { lastDetailsSentAt: '2026-09-23T13:25:00Z', recentNotifications: [{ type:'reminder', channel:'email', status:'delivered', createdAt:'2026-09-23T14:00:00Z' }] } };
  },
});
vm.runInContext('async function invoke(btn) { var id = "booking-fixture";' + dashboard.slice(branchStart, branchEnd) + '\n}', resendUi);
const button = { disabled: false };
await resendUi.invoke(button);
assert.equal(resendCalls.length, 1, 'Cancelling preview never posts a send');
assert.equal(button.disabled, false);
allowSend = true; failPost = true;
await resendUi.invoke(button);
const firstId = JSON.parse(resendCalls.at(-1).options.body).requestId;
failPost = false; duplicate = true;
await resendUi.invoke(button);
assert.equal(JSON.parse(resendCalls.at(-1).options.body).requestId, firstId, 'Timeout retry must retain the deliberate action identity');
assert.match(toasts.at(-1).text, /already sent.*No duplicate/);
assert.equal(uuidCalls, 1);
button.disabled = true;
const before = resendCalls.length;
await resendUi.invoke(button);
assert.equal(resendCalls.length, before, 'An in-flight click cannot start another send');
console.log('Notification owner visibility: PASS (deferred/uncertain/cancelled truth, private outbox exclusion, broadcast outcomes, owner action copy)');
