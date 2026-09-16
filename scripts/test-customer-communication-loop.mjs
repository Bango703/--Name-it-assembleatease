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

console.log('Customer communication loop regression tests passed.');