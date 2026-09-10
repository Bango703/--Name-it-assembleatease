#!/usr/bin/env node
// Owner click-to-call: the customer must never learn the owner's personal
// number, and this endpoint must never become an open dialer.
//
// The owner dashboard renders customer numbers as `tel:` links. Tapping one
// dials from the owner's own handset, so the customer sees that number on their
// screen and keeps it — every callback afterwards reaches a personal phone
// rather than the business. This bridges instead: Telnyx rings the owner,
// presented as the business number, and only dials the customer once the owner
// has picked up.
//
// Two things must hold, and both are asserted here:
//
//   THE NUMBER TO DIAL NEVER COMES FROM THE BROWSER. It is read from the
//   booking. An owner password is not authority to dial an arbitrary number
//   through the business line, and accepting one from the request would turn
//   this into an open dialer the moment that password leaked.
//
//   THE WEBHOOK IS AUTHENTICATED. It is a public endpoint that places outbound
//   calls. Without a signature check anyone could forge an answer event and
//   make the business line dial a number of their choosing.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ownerCallConfig,
  buildOwnerLegRequest,
  buildCustomerLegRequest,
  parseClientState,
} from '../api/_owner-call.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const CONFIG = {
  apiKey: 'KEY', appId: 'app-1',
  from: '+19792325139', ownerPhone: '+17372906129', enabled: true, missing: [],
};

// ------------------------------------------------------------ configuration --
const off = ownerCallConfig({});
assert.equal(off.enabled, false, 'Calling must be off when unconfigured');
assert.ok(off.missing.length >= 3, 'It must name what is missing, not just fail');

// --------------------------------------------------------- the owner's leg --
const leg = buildOwnerLegRequest(CONFIG, {
  customerPhone: '512-555-0147', bookingId: 'b-1', bookingRef: 'AAE-TEST',
});
assert.equal(leg.ok, true);
assert.equal(leg.body.to, CONFIG.ownerPhone, 'The OWNER is dialled first, not the customer');
assert.equal(leg.body.from, CONFIG.from, 'The call presents the business number');
assert.notEqual(leg.body.to, leg.customerPhone, 'The customer must not be the first leg');

// A customer is never rung before the owner is on the line, and never at all if
// the owner does not answer.
assert.ok(leg.body.timeout_secs > 0, 'The owner leg must time out rather than ring forever');

// Bad numbers are refused rather than dialled.
assert.equal(buildOwnerLegRequest(CONFIG, { customerPhone: '555' }).ok, false);
assert.equal(buildOwnerLegRequest(CONFIG, { customerPhone: '' }).ok, false);

// ------------------------------------------------------------ client state --
const state = parseClientState(leg.body.client_state);
assert.ok(state, 'The state Telnyx returns must be readable');
assert.equal(state.customer, '+15125550147', 'The customer number rides in state, normalised');
assert.equal(state.ref, 'AAE-TEST');

// Anything not produced by this platform is rejected, so a forged answer event
// cannot smuggle in a number to dial.
assert.equal(parseClientState('garbage'), null);
assert.equal(parseClientState(''), null);
assert.equal(
  parseClientState(Buffer.from(JSON.stringify({ v: 1, stage: 'owner_leg', customer: 'nope' })).toString('base64')),
  null,
  'State carrying an invalid number must be rejected',
);
assert.equal(
  parseClientState(Buffer.from(JSON.stringify({ v: 1, stage: 'customer_leg', customer: '+15125550147' })).toString('base64')),
  null,
  'Only an owner leg may trigger a second call',
);

// -------------------------------------------------------- the customer leg --
const second = buildCustomerLegRequest(CONFIG, state, 'ccid-123');
assert.equal(second.to, '+15125550147', 'The second leg dials the customer');
assert.equal(second.from, CONFIG.from, 'The customer sees the business number, never the owner personal one');
assert.notEqual(second.from, CONFIG.ownerPhone, 'The whole point: the personal number is never presented');
assert.equal(second.link_to, 'ccid-123', 'link_to is what bridges the legs');

// --------------------------------------------------------------- endpoints --
const endpoint = await read('api/owner/call-customer.js');
assert.match(endpoint, /verifyOwner\(req\)/, 'The endpoint must be owner-authenticated');
assert.match(endpoint, /\.from\('bookings'\)/, 'The number must be read from the booking');
assert.doesNotMatch(endpoint, /req\.body\?\.(to|phone|customerPhone|number)/,
  'A phone number must never be accepted from the request — that is an open dialer');
assert.match(endpoint, /CALLING_NOT_CONFIGURED/, 'An unconfigured install must say so');

const webhook = await read('api/webhooks/telnyx-call-control.js');
assert.match(webhook, /verifyVoiceSignature/, 'The webhook must verify the Telnyx signature');
assert.match(webhook, /call\.answered/, 'Only an answered owner leg starts the second call');
assert.match(webhook, /parseClientState/, 'The number dialled must come from our own state');
assert.doesNotMatch(webhook, /payload\.to\b/, 'Never dial a number taken from the event body');
// A retry would ring the customer twice, so failures still return 200.
assert.match(webhook, /return res\.status\(200\)[\s\S]*bridged/, 'Failures must not trigger a Telnyx retry');

const envExample = await read('.env.example');
assert.match(envExample, /^TELNYX_CALL_CONTROL_APP_ID=/m);
assert.match(envExample, /^OWNER_PERSONAL_PHONE=/m);

const dashboard = await read('owner/index.html');
assert.match(dashboard, /callCustomerViaBusinessLine/, 'The dashboard must expose the action');
assert.match(dashboard, /Call via business line/);
assert.match(dashboard, /toast\(e && e\.message/, 'Failures must show the server reason, not a generic message');

// apiPost() prefixes /api/booking; an owner route through it 404s. ownerPost()
// prefixes /api/owner, which is where this endpoint lives.
assert.match(dashboard, /ownerPost\("\/call-customer"/,
  'The dashboard must call the owner route through ownerPost, not apiPost');
assert.doesNotMatch(dashboard, /apiPost\("\/owner\/call-customer"/,
  'apiPost would resolve to /api/booking/owner/call-customer and 404');

console.log('PASS owner click-to-call: owner rung first, customer number never from the browser, '
  + 'business number always presented, webhook authenticated');
