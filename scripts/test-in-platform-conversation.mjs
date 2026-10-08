#!/usr/bin/env node
// Customer and Easer talk to each other on the platform only (owner,
// 2026-09-29: "the customer and easer can have a conversation without me").
//
// Before: the Easer's message reached the customer by email saying "Reply to
// this email and we'll pass it straight to [Easer]", with the reply address
// set to the owner's inbox, so the owner relayed every reply by hand. A
// customer reply on the booking page reached the Easer by email only. The
// booking page told the customer their note went to "the AssembleAtEase team"
// even when the server delivered it to the Easer.
//
// Now: every email and text is a doorbell with a button into the platform;
// replies happen on the booking page (customer) and the Jobs screen (Easer);
// the Easer gets push + one throttled text; the owner gets an FYI copy; and
// the booking page labels the box with the recipient the server routes to.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerMessageRecipient } from '../api/booking/_message-routing.js';

// Routing rule
assert.equal(customerMessageRecipient({ assembler_id: 'e1', assembler_accepted_at: '2026-09-29T10:00:00Z' }), 'assembler');
assert.equal(customerMessageRecipient({ assembler_id: 'e1', assembler_accepted_at: null }), 'owner', 'an assignment nobody accepted has no pro to talk to');
assert.equal(customerMessageRecipient({ assembler_id: null }), 'owner');

const msg = readFileSync('api/booking/message.js', 'utf8');
const track = readFileSync('api/booking/track.js', 'utf8');
const page = readFileSync('track.html', 'utf8');

// One rule, used by the API that routes and the API that labels
assert.match(msg, /resolvedRecipient = customerMessageRecipient\(booking\)/);
assert.doesNotMatch(msg, /resolvedSender === 'customer' && booking\.assembler_id && booking\.assembler_accepted_at/, 'routing must not be decided inline again');
assert.match(track, /message_recipient: customerMessageRecipient\(booking\) === 'assembler' \? 'pro' : 'team'/);

// Email is a doorbell, never a relay the owner has to work
assert.doesNotMatch(msg, /Reply to this email and we'll pass it/, 'the owner-relay promise is back');
assert.match(msg, /guestManageUrl\(booking, SITE\) \+ '#bookingCommunication'/, 'the customer email must link into the booking page conversation');
assert.match(msg, />Reply to \$\{esc\(relayFirstName\)\}<\/a>/);
assert.match(msg, /\/assembler\/my-assignments\?job=\$\{encodeURIComponent\(booking\.id\)\}/, 'the Easer email/push must open the job');
assert.match(msg, />Open the job to reply<\/a>/);

// The Easer is actually reached: push + a throttled, consent-gated text
const easerBlock = msg.slice(msg.indexOf("const easerJobUrl"), msg.indexOf("if (easerProfile?.email) {", msg.indexOf("const easerJobUrl")));
assert.match(easerBlock, /sendPushToUser\(booking\.assembler_id/);
assert.match(easerBlock, /sendSms\(\{\s*recipient: easerProfile/, 'the text goes through sendSms, which enforces consent');
assert.match(easerBlock, /notification_type', 'customer_message_easer'\)[\s\S]*gte\('created_at', since\)/, 'one text per booking per 30 minutes');
assert.match(msg, /\.select\('email, full_name, phone, sms_consent_at, sms_opted_out_at'\)/, 'consent fields must be loaded for the gate to work');

// The owner is informed, not asked to act, when the Easer already has it
assert.match(msg, /'FYI: customer messaged the Easer — '/);
assert.match(msg, /Delivered to the assigned Easer in the app\. No action needed/);

// The booking page says who receives the message, from the server's answer
assert.match(page, /currentBooking\.message_recipient === 'pro'/);
assert.match(page, /'Your message goes straight to ' \+ proName/);
assert.match(page, /window\.location\.hash === '#bookingCommunication'/, 'the Reply button must land on the conversation');

console.log('PASS in-platform conversation: one routing rule, email/text are doorbells into the platform, Easer gets push + throttled text, owner gets an FYI copy.');
