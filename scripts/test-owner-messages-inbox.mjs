#!/usr/bin/env node
// Owner Messages inbox, 2026-10-01. Owner: "WHERE IS MY MESSAGES TAB ? NO
// MESSAGES GET RECIEVE ON DASHBOARD". Since customers and Easers write to each
// other directly (2026-09-29), the dashboard only counted messages addressed to
// the owner and labelled every customer message "Customer to Owner". This holds:
//   - every message is listed and labelled with who wrote to whom (server-owned)
//   - "waiting for you" is decided on the server and is the badge
//   - inside a booking, a customer-Easer message appears in both threads
//   - a visitor's browser-extension error is not a platform error

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendSmsConversations, messageDirectionLabel, messageNeedsOwner, buildConversations } from '../api/_owner-inbox.js';
import { createOwnerMessagesHandler } from '../api/owner/messages.js';
import { isBrowserExtensionNoise } from '../api/_runtime-noise.js';
import { classifyRuntimeFailures } from '../api/owner/live-ops.js';

const read = (f) => readFileSync(f, 'utf8');

// ── 1. Who wrote to whom ─────────────────────────────────────────────────────
assert.equal(messageDirectionLabel({ sender: 'customer', recipient_type: 'assembler' }), 'Customer to Easer');
assert.equal(messageDirectionLabel({ sender: 'assembler', recipient_type: 'customer' }), 'Easer to Customer');
assert.equal(messageDirectionLabel({ sender: 'customer', recipient_type: 'owner' }), 'Customer to You');
assert.equal(messageDirectionLabel({ sender: 'owner', recipient_type: 'assembler' }), 'You to Easer');
assert.equal(messageDirectionLabel({ sender: 'customer' }), 'Customer to You', 'rows from before recipient_type went to the owner');
assert.equal(messageNeedsOwner({ sender: 'customer', recipient_type: 'assembler' }), false, 'a direct customer-Easer message needs nothing from the owner');
assert.equal(messageNeedsOwner({ sender: 'assembler', recipient_type: 'owner' }), true);
assert.equal(messageNeedsOwner({ sender: 'owner', recipient_type: 'customer' }), false);

// ── 2. Conversations ─────────────────────────────────────────────────────────
{
  const msgs = [
    { booking_id: 'b1', sender: 'customer', recipient_type: 'assembler', body: 'Gate code 1234', created_at: '2026-10-01T15:00:00Z' },
    { booking_id: 'b1', sender: 'assembler', recipient_type: 'customer', body: 'On my way', created_at: '2026-10-01T15:05:00Z' },
    { booking_id: 'b2', sender: 'customer', recipient_type: 'owner', body: 'Can I move my time?', created_at: '2026-10-01T14:00:00Z', read_at: null },
    { booking_id: 'b3', sender: 'customer', recipient_type: 'owner', body: 'Thanks', created_at: '2026-10-01T10:00:00Z', read_at: '2026-10-01T10:05:00Z' },
    { booking_id: 'b3', sender: 'owner', recipient_type: 'customer', body: 'You are welcome', created_at: '2026-10-01T10:06:00Z' },
  ];
  const bookings = [{ id: 'b1', ref: 'AAE-1', customer_name: 'Dana', assembler_id: 'e1', status: 'confirmed' }, { id: 'b2', ref: 'AAE-2', customer_name: 'Lee' }, { id: 'b3', ref: 'AAE-3' }];
  const { conversations, needsReply } = buildConversations(msgs, bookings, new Map([['e1', 'Trapper']]));
  assert.deepEqual(needsReply, ['b2'], 'only a conversation whose latest message was written to the owner waits for the owner');
  assert.equal(conversations[0].bookingId, 'b2', 'waiting conversations come first');
  const b1 = conversations.find(c => c.bookingId === 'b1');
  assert.equal(b1.messageCount, 2, 'direct customer-Easer messages are listed');
  assert.equal(b1.lastMessage.direction, 'Easer to Customer');
  assert.equal(b1.easerName, 'Trapper');
  assert.equal(b1.openThread, 'assembler');
  assert.equal(b1.direct, true);
  assert.equal(conversations.find(c => c.bookingId === 'b2').direct, false);
  assert.equal(conversations.find(c => c.bookingId === 'b2').unreadForOwner, 1);
  assert.equal(conversations.find(c => c.bookingId === 'b3').needsReply, false, 'answered by the owner');
}

{
  const inbox = appendSmsConversations({ conversations: [], needsReply: [] }, [{
    id: 'sms-1', phone: '+15125550101', customer_name: 'Casey', booking_id: 'b1', easer_id: null,
    status: 'open', last_message_at: '2026-10-01T16:00:00Z', last_message_preview: 'Can you move the visit?',
    unread_count: 1, bookings: { id: 'b1', ref: 'AAE-1', status: 'confirmed' }, profiles: null,
  }]);
  assert.deepEqual(inbox.needsReply, ['sms:sms-1'], 'an unread inbound SMS waits for the owner');
  assert.equal(inbox.conversations[0].kind, 'sms');
  assert.equal(inbox.conversations[0].conversationId, 'sms-1');
  assert.equal(inbox.conversations[0].lastMessage.direction, 'SMS to You');
}

// ── 3. Endpoint ──────────────────────────────────────────────────────────────
function res() { return { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function db(tables) {
  return { from(t) { const r = tables[t]; const b = { select() { return b; }, gte() { return b; }, order() { return b; }, limit() { return b; }, in() { return b; }, then(ok, ko) { return Promise.resolve(r).then(ok, ko); } }; return b; } };
}
{
  const r = res();
  await createOwnerMessagesHandler({ authorize: () => false, supabase: () => { throw new Error('no'); } })({ method: 'GET' }, r);
  assert.equal(r.statusCode, 401, 'owner only');
}
{
  const r = res();
  await createOwnerMessagesHandler({ authorize: () => true, supabase: () => db({ messages: { data: null, error: { message: 'timeout' } } }) })({ method: 'GET' }, r);
  assert.equal(r.statusCode, 503, 'a failed read is an error, never an empty inbox');
}
{
  const r = res();
  await createOwnerMessagesHandler({ authorize: () => true, supabase: () => db({
    messages: { data: [{ booking_id: 'b1', sender: 'customer', recipient_type: 'assembler', body: 'hi', created_at: '2026-10-01T15:00:00Z' }], error: null },
    bookings: { data: [{ id: 'b1', ref: 'AAE-1', customer_name: 'Dana', assembler_id: 'e1' }], error: null },
    profiles: { data: [{ id: 'e1', full_name: 'Trapper' }], error: null },
    sms_conversations: { data: [{ id: 'sms-1', phone: '+15125550101', customer_name: 'Casey', booking_id: 'b1', easer_id: null, status: 'open', last_message_at: '2026-10-01T16:00:00Z', last_message_preview: 'text', unread_count: 1, bookings: null, profiles: null }], error: null },
  }) })({ method: 'GET' }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.conversations[0].lastMessage.direction, 'SMS to You');
  assert.deepEqual(r.body.needsReply, ['sms:sms-1']);
}

// ── 4. Booking thread in the dashboard ──────────────────────────────────────
const msgApi = read('api/booking/message.js');
assert.match(msgApi, /ownerRequest \? \(msgs \|\| \[\]\)\.map\(m => \(\{ \.\.\.m, direction: messageDirectionLabel\(m\) \}\)\)/, 'owner reads carry the server label');
const dash = read('owner/index.html');
assert.doesNotMatch(dash, /'Easer to Owner' : 'Customer to Owner'/, 'no hardcoded "to Owner" label for direct messages');
assert.match(dash, /var senderLabel = m\.direction \|\| 'Message';/);
assert.match(dash, /if \(target === 'assembler'\) return m\.sender === 'assembler' \|\| m\.recipient_type === 'assembler';/, 'Easer tab shows everything the Easer wrote or received');
assert.match(dash, /return m\.sender === 'customer' \|\| m\.recipient_type === 'customer';/, 'customer tab shows everything the customer wrote or received');
assert.match(dash, /data-view="messages"/);
assert.match(dash, /id="nav-inbox"/);
assert.doesNotMatch(dash, /id="nav-messages"/, 'one message badge, not two counting different things');
assert.match(dash, /<script src="\/owner\/assets\/messages\.js" defer><\/script>/);
assert.match(dash, /\$messagesView,/);
const panel = read('owner/assets/messages.js');
assert.match(panel, /state\.data\.needsReply\.length/, 'badge is the server list length');
assert.doesNotMatch(panel, /recipientType === 'owner' &&|sender !== 'owner' && .*recipient/, 'the panel does not decide what needs a reply');
assert.match(panel, /\/api\/owner\/sms-messages/, 'SMS rows open the SMS thread API');
assert.match(panel, /sendSmsReply/, 'SMS rows can be answered from Messages');
assert.match(dash, /id="sms-panel"/, 'Messages contains the SMS thread');
assert.match(dash, /id="sms-reply-send"/, 'Messages contains the SMS reply action');
assert.match(read('api/webhooks/telnyx.js'), /recordSmsConversationMessage/, 'inbound SMS reaches the owner conversation');
assert.match(read('api/webhooks/telnyx.js'), /await recordSmsConversationMessage[\s\S]*notification_log/, 'conversation recording precedes the notification log');
assert.match(read('api/owner/sms-messages.js'), /sendSms\(/, 'owner SMS replies go through the one SMS sender');
assert.match(read('api/owner/sms-messages.js'), /status: 'suppressed'/, 'a consent-blocked reply is saved as not sent');
assert.match(read('api/migrations/100_owner_sms_conversations.sql'), /CREATE TABLE IF NOT EXISTS public\.sms_conversations/i, 'SMS conversations exist in migrations');
assert.match(read('api/migrations/100_owner_sms_conversations.sql'), /CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_provider/i, 'Telnyx retries dedupe by provider ID');

// ── 5. Browser extension errors ─────────────────────────────────────────────
assert.equal(isBrowserExtensionNoise({ message: 'Invalid call to runtime.sendMessage(). Tab not found.' }), true, 'the 2026-10-01 Live Ops alert');
assert.equal(isBrowserExtensionNoise({ message: 'x is not defined', stack: 'at chrome-extension://abc/content.js:1:1' }), true);
assert.equal(isBrowserExtensionNoise({ message: "Cannot read properties of null (reading 'value')", source: 'https://www.assembleatease.com/book' }), false, 'our own errors still report');
{
  const { history } = classifyRuntimeFailures([
    { reason_detail: 'Invalid call to runtime.sendMessage(). Tab not found.', created_at: '2026-10-01T19:13:00Z' },
    { reason_detail: 'Booking total is not a number', created_at: '2026-10-01T19:14:00Z' },
  ], '2026-10-01T18:00:00Z');
  assert.equal(history.length, 1, 'Live Ops hides stored extension errors');
  assert.equal(history[0].detail, 'Booking total is not a number');
}
assert.match(read('api/observability/runtime-error.js'), /isBrowserExtensionNoise\(\{ message, source, stack \}\)/, 'intake drops extension errors');

console.log('PASS owner messages inbox: every conversation listed with who wrote to whom, waiting-for-you decided on the server, direct customer-Easer messages in both booking threads, extension errors kept out of Live Ops.');
