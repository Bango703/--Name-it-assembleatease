#!/usr/bin/env node
// The AssembleAtEase customer app (owner, 2026-10-13: "work on the customer as
// well ... both on Apple, built like the Easer app"). The app signs a customer
// in with a code sent to their email, and every booking action accepts that
// sign-in the same way it accepts the booking page's emailed link.
//
// What must hold:
//   - one check decides whether a request may act on a booking, and every
//     customer booking endpoint uses it (no endpoint keeps its own copy);
//   - a session proves ownership only when its email is confirmed, and a
//     booking bound to one account never opens for another;
//   - the sign-in hands out customer sessions only (never an Easer's);
//   - the booking list shows the pro's first name only after they accept.
// Real handlers run against in-memory stand-ins; no network, no live data.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  customerBookingAccess,
  customerAccountUser,
  usesCustomerAccount,
  bearerToken,
} from '../api/booking/_customer-access.js';
import { customerStatusLabel } from '../api/booking/_customer-status.js';

const read = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '');
const sha = (v) => createHash('sha256').update(v).digest('hex');

// A Supabase stand-in whose getUser answers by token.
function authStub(users) {
  return { auth: { async getUser(jwt) { const user = users[jwt]; return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }; } } };
}
const req = (jwt) => ({ headers: jwt ? { authorization: 'Bearer ' + jwt } : {} });

// ── 1. The one access check ──────────────────────────────────────────────────
{
  const confirmed = { id: 'u1', email: 'Jordan@Example.com', email_confirmed_at: '2026-10-13T00:00:00Z' };
  const unconfirmed = { id: 'u2', email: 'jordan@example.com', email_confirmed_at: null };
  const other = { id: 'u3', email: 'someone@example.com', email_confirmed_at: '2026-10-13T00:00:00Z' };
  const sb = authStub({ good: confirmed, raw: unconfirmed, other });
  const booking = { id: 'b1', customer_email: 'jordan@example.com', customer_id: null, guest_mutation_token_hash: sha('link-token') };

  assert.equal((await customerBookingAccess(sb, req(), booking, { email: 'jordan@example.com', token: 'link-token' })).via, 'link', 'the emailed link still works');
  assert.equal((await customerBookingAccess(sb, req(), booking, { email: 'jordan@example.com', token: 'wrong' })).ok, false);
  assert.equal((await customerBookingAccess(sb, req(), booking, { email: 'other@example.com', token: 'link-token' })).ok, false, 'the link needs the booking email');
  assert.equal((await customerBookingAccess(sb, req('good'), booking, { token: 'wrong' })).ok, false, 'a bad link is refused even with a session: the link is checked when given');

  const viaApp = await customerBookingAccess(sb, req('good'), booking);
  assert.equal(viaApp.ok, true, 'the signed-in owner of the email opens it');
  assert.equal(viaApp.via, 'account');
  assert.equal((await customerBookingAccess(sb, req('raw'), booking)).ok, false, 'an unconfirmed email proves nothing');
  assert.equal((await customerBookingAccess(sb, req('other'), booking)).ok, false, "another customer's session does not open it");
  assert.equal((await customerBookingAccess(sb, req('nobody'), booking)).ok, false, 'an invalid session does not open it');
  assert.equal((await customerBookingAccess(sb, req('good'), { ...booking, customer_id: 'u9' })).ok, false, 'a booking bound to another account never falls back to email');
  assert.equal((await customerBookingAccess(sb, req('good'), null)).ok, false);

  assert.equal(await customerAccountUser(sb, req('raw')), null);
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(usesCustomerAccount(req('good'), { token: 'x' }), false, 'a link token, when sent, is what gets checked');
  assert.equal(usesCustomerAccount(req('good'), {}), true);
}

// ── 2. Every customer booking endpoint uses it, and only it ──────────────────
{
  const endpoints = {
    'api/booking/track.js': /customerBookingAccess\(sb, req, booking, \{ email, token \}\)/,
    'api/booking/reschedule.js': /customerBookingAccess\(sb, req, booking, \{ email, token \}\)/,
    'api/booking/guest-cancel.js': /customerBookingAccess\(sb, req, booking, \{ email, token \}\)/,
    'api/booking/time-proposal.js': /customerBookingAccess\(sb, req, booking, \{ email, token \}\)/,
    'api/booking/customer-photos.js': /customerBookingAccess\(sb, req, data, \{ email, token \}\)/,
    'api/booking/message.js': /customerBookingAccess\(sb, req, ownBooking\)/,
  };
  for (const [file, pattern] of Object.entries(endpoints)) {
    const source = read(file);
    assert.match(source, pattern, `${file} asks the one access check`);
    assert.doesNotMatch(source, /safeTokenHashMatch\(token, (booking|data)\.guest_mutation_token_hash\)/, `${file} keeps no copy of the link check`);
  }
  const message = read('api/booking/message.js');
  assert.match(message, /const customer = await customerAccountUser\(sb, req\);/, 'a signed-in customer message needs a confirmed email');
  assert.match(read('api/booking/customer-bookings.js'), /const user = await customerAccountUser\(sb, req\);/);
}

// ── 3. The booking list: the booking page's words, the pro's first name only after acceptance ──
{
  const list = read('api/booking/customer-bookings.js');
  assert.match(list, /pro_first_name: b\.assembler_accepted_at && b\.assembler_name \? String\(b\.assembler_name\)\.split\(' '\)\[0\] : null/);
  assert.doesNotMatch(list, /assembler_name: assemblerMap/, 'no full name before acceptance');
  assert.doesNotMatch(list, /\.\.\.b,/, 'the list returns named fields, not the whole row');
  assert.match(read('api/booking/track.js'), /const customerStatus = customerStatusLabel\(booking\);/, 'the booking page and the list share the words');
  assert.equal(customerStatusLabel({ status: 'confirmed', assembler_id: 'e1' }).label, 'Matching you with a service pro');
  assert.equal(customerStatusLabel({ status: 'confirmed', assembler_id: 'e1', assembler_accepted_at: 'x', assembler_name: 'Pat Doe', date: '2026-10-20', time: '10:00 AM - 12:00 PM' }).label, 'Pat is confirmed for your job');
  const track = read('api/booking/track.js');
  assert.match(track, /reschedule_options: \{ slots: TIME_SLOTS, window_days: BOOKING_WINDOW_DAYS \}/, 'reschedule times come from the rule reschedule.js enforces');
  assert.match(track, /loadBookingItems\(booking\.id, \{ sb, includePricing: true \}\)/, 'the customer sees what they booked, with their prices');
}

// ── 4. Sign-in: a code, then a customer session ──────────────────────────────
{
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const source = read('api/customer/sign-in.js')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/export default async function/, 'async function')
    .replace(/export async function /g, 'async function ');

  const codes = new Map();
  const sentEmails = [];
  const accounts = new Map([['pro@example.com', { id: 'easer-1', email: 'pro@example.com', user_metadata: { role: 'assembler' } }]]);
  const profiles = new Map([['easer-1', { role: 'assembler' }]]);
  const sb = {
    auth: { admin: {
      async createUser({ email }) {
        if (accounts.has(email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
        accounts.set(email, { id: 'cust-' + accounts.size, email, user_metadata: { role: 'customer' } });
        return { data: { user: accounts.get(email) }, error: null };
      },
      async generateLink({ email }) { return { data: { user: accounts.get(email), properties: { email_otp: 'otp-' + email } }, error: null }; },
    } },
    from() {
      let id;
      const q = { select() { return q; }, eq(_c, v) { id = v; return q; }, async maybeSingle() { return { data: profiles.get(id) || null }; } };
      return q;
    },
  };
  const deps = {
    getSupabase: () => sb,
    sendEmail: async (m) => { sentEmails.push(m); return { ok: true }; },
    ownerEmail: () => 'owner@example.com',
    esc: (s) => String(s),
    rateLimit: async () => true,
    rateLimitKey: async () => true,
    isValidPromoEmail: (e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e),
    normalizeEmail: (e) => String(e || '').trim().toLowerCase(),
    generateAndStoreCode: async (_sb, email, purpose) => { codes.set(email + purpose, '123456'); return '123456'; },
    verifyCode: async (_sb, email, code, purpose) => codes.get(email + purpose) === code,
    ASSEMBLECASH: { CODE_TTL_MIN: 10 },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = accounts.get(body.email);
      return { ok: body.token === 'otp-' + body.email, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, user }) };
    },
  };
  const { handler } = await new AsyncFunction(...Object.keys(deps), `${source}\nreturn { handler };`)(...Object.values(deps));
  const call = async (body) => {
    const res = { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ method: 'POST', body, headers: {} }, res);
    return res;
  };

  const sent = await call({ action: 'send', email: ' New@Example.com ' });
  assert.equal(sent.statusCode, 200);
  assert.match(sentEmails.at(-1).subject, /123456/);
  assert.equal(sentEmails.at(-1).to, 'new@example.com');
  assert.equal((await call({ action: 'verify', email: 'new@example.com', code: '000000' })).statusCode, 400, 'a wrong code is refused');
  const session = await call({ action: 'verify', email: 'new@example.com', code: '123456' });
  assert.equal(session.statusCode, 200, JSON.stringify(session.body));
  assert.deepEqual(Object.keys(session.body).sort(), ['access_token', 'expires_in', 'refresh_token', 'user'], "Supabase's own token shape, which the app already reads");
  assert.equal(accounts.get('new@example.com').user_metadata.role, 'customer', 'the first sign-in creates a customer account');

  await call({ action: 'send', email: 'pro@example.com' });
  const easer = await call({ action: 'verify', email: 'pro@example.com', code: '123456' });
  assert.equal(easer.statusCode, 409, 'an Easer email never gets a customer session');
  assert.doesNotMatch(JSON.stringify(easer.body), /access_token/);
  assert.equal((await call({ action: 'verify', email: 'not-an-email', code: '123456' })).statusCode, 400);
}

console.log('PASS customer app access: one check for link or app sign-in, confirmed email only, no cross-account access, Easer emails refused, first name only after acceptance.');
