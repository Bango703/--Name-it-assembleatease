import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const message = await read('api/booking/message.js');
const photos = await read('api/booking/customer-photos.js');
const migration = await read('api/migrations/095_customer_booking_photos.sql');
const track = await read('track.html');
const owner = await read('owner/index.html');
const easer = await read('assembler/my-assignments.html');

assert.match(message, /rateLimit\(ip, 'booking'\)/);
assert.match(message, /safeTokenHashMatch\(token, guestBooking\.guest_mutation_token_hash\)/);
assert.match(message, /bookingEmailMatches\(guestBooking, email\)/);
assert.match(message, /return res\.status\(404\)\.json\(\{ error: 'Booking not found' \}\)/);
assert.match(message, /\.insert\(\{[\s\S]*recipient_type: resolvedRecipient/);
assert.match(message, /notificationType: 'customer_message'/);
assert.match(message, /assembler_accepted_at/);
assert.match(message, /sender\.eq\.customer/);

assert.match(photos, /safeTokenHashMatch\(token, data\.guest_mutation_token_hash\)/);
assert.match(photos, /bookingEmailMatches\(data, email\)/);
assert.match(photos, /MAX_BYTES = 5 \* 1024 \* 1024/);
assert.match(photos, /magicMatches\(mimeType, buf\)/);
assert.match(photos, /booking_customer_photos/);
assert.match(photos, /customer-uploads\//);
assert.match(photos, /createSignedUrl/);
assert.match(photos, /requireAssignedWorkEaser/);
assert.match(photos, /!data\.assembler_accepted_at/);
assert.doesNotMatch(photos, /booking_evidence/);
assert.doesNotMatch(photos, /record_booking_evidence|payout|financial_operation/);

assert.match(migration, /booking_customer_photos/);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE ALL ON TABLE public\.booking_customer_photos/);
assert.match(migration, /file_size_bytes <= 5242880/);
assert.doesNotMatch(migration, /completion_photo|payout/);

assert.match(track, /bookingCommunication/);
assert.match(track, /currentMutationToken/);
assert.match(track, /customer-photos/);
assert.match(track, /5 \* 1024 \* 1024/);
assert.match(owner, /customer-photos\?bookingId/);
assert.match(owner, /Customer Photos \(Private\)/);
assert.match(easer, /customer-photos\?bookingId/);

// ── An Easer's question must reach the customer, and be chased if ignored ──
// An Easer asked for a photo of the item, the relay went out by email only, the
// customer never opened it, and the job reached the day before anyone noticed.
{
  const relay = await read('api/booking/message.js');
  assert.match(relay, /sendSms\(\{/, 'the relay must also text the customer');
  assert.match(relay, /sms_consent_at: booking\.sms_consent_at/,
    'the text goes only where consent was given at checkout');
  assert.match(relay, /sms_opted_out_at: booking\.sms_opted_out_at/,
    'and never after an opt-out');
  assert.doesNotMatch(relay, /body: `AssembleAtEase: \$\{relayFirstName\} sent a question[^`]*\$\{sBody\}/,
    'the message body stays in the email; the text is only a doorbell');
  assert.match(relay, /smsDelivery:/,
    'the timeline must record the text outcome separately from the email');

  const liveOps = await read('api/owner/live-ops.js');
  assert.match(liveOps, /customer_relay_unanswered/,
    'an unanswered question before a visit must reach the owner');
  assert.match(liveOps, /RELAY_GRACE_MS/,
    'a question asked minutes ago is not yet unanswered');
  assert.match(liveOps, /if \(replyAt > relayAt\) return;/,
    'any customer reply after the question closes it');
  assert.match(liveOps, /hoursUntil > 48/,
    'only raised while there is still time to act on it');
}

// ── A typed message must arrive shaped the way it was written ──────────────
// esc() leaves line breaks alone and HTML collapses them, so every message the
// owner typed with paragraphs arrived as one run-on block. Reported as
// "no matter how i type message it always sends jammed up".
{
  const relay = await read('api/booking/message.js');
  // Plain substring checks on purpose: the thing under test is itself a regex,
  // and asserting a regex with a regex is how the first version of this broke.
  assert.ok(relay.includes('esc(messageText).replace('),
    'line breaks must be converted AFTER escaping, so nothing typed can inject markup');
  assert.ok(relay.includes("'<br>'"),
    'line breaks must become <br>; Outlook ignores white-space:pre-wrap');
  assert.ok(!relay.includes('esc(messageText.replace'),
    'escape first, then add the breaks, or the breaks are escaped into visible text');
}

console.log('Customer communication loop regression tests passed.');