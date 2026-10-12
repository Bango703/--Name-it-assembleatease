import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { normalizeUsPhone } from './_phone.js';

/**
 * THE rules for confirming an Easer's new phone number (migration 109).
 *
 * Owner, 2026-10-12: a changed number was texted at once on consent given for
 * the old one, so a typo sent job offers to a stranger. Now the new number gets
 * a 6-digit code and is saved only once the code is entered, the way Uber and
 * DoorDash confirm a number. Pure functions; api/assembler/phone-verification.js
 * does the reading and writing.
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 30 * 1000;
export const MAX_SENDS_PER_WINDOW = 5;
export const SEND_WINDOW_MS = 60 * 60 * 1000;

export function newCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** "salt$sha256(salt:code)". The code itself is never stored. */
export function hashCode(code, salt = randomBytes(16).toString('hex')) {
  const digest = createHash('sha256').update(`${salt}:${String(code)}`).digest('hex');
  return `${salt}$${digest}`;
}

export function codeMatches(code, stored) {
  const clean = String(code || '').replace(/\D/g, '');
  const [salt, digest] = String(stored || '').split('$');
  if (clean.length !== 6 || !salt || !digest) return false;
  const expected = Buffer.from(hashCode(clean, salt).split('$')[1], 'hex');
  const actual = Buffer.from(digest, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The forms a stored number may take, for finding it on another account. */
export function phoneLookupVariants(e164) {
  const phone = normalizeUsPhone(e164);
  if (!phone) return [];
  const ten = phone.slice(2);
  return [...new Set([
    phone,
    ten,
    `1${ten}`,
    `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`,
    `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`,
  ])];
}

export function samePhone(a, b) {
  const x = normalizeUsPhone(a);
  return Boolean(x) && x === normalizeUsPhone(b);
}

/**
 * May a code be sent now? `pending` is the Easer's current verification row or
 * null. Returns the counters to write when it may.
 */
export function sendDecision(pending, now = Date.now()) {
  if (!pending) return { ok: true, sendCount: 1, windowStartedAt: new Date(now).toISOString() };
  const lastSent = Date.parse(pending.last_sent_at);
  if (Number.isFinite(lastSent) && now - lastSent < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - lastSent)) / 1000);
    return { ok: false, status: 429, error: `Wait ${wait} seconds, then send a new code.`, retryAfterSeconds: wait };
  }
  const windowStart = Date.parse(pending.window_started_at);
  const inWindow = Number.isFinite(windowStart) && now - windowStart < SEND_WINDOW_MS;
  if (inWindow && Number(pending.send_count || 0) >= MAX_SENDS_PER_WINDOW) {
    const wait = Math.ceil((SEND_WINDOW_MS - (now - windowStart)) / 60000);
    return { ok: false, status: 429, error: `Too many codes sent. Try again in ${wait} minutes.`, retryAfterSeconds: wait * 60 };
  }
  return inWindow
    ? { ok: true, sendCount: Number(pending.send_count || 0) + 1, windowStartedAt: pending.window_started_at }
    : { ok: true, sendCount: 1, windowStartedAt: new Date(now).toISOString() };
}

/** Does this code confirm the pending number? */
export function verifyDecision(pending, code, now = Date.now()) {
  if (!pending) return { ok: false, status: 404, error: 'Send a code to your new number first.' };
  if (!(Date.parse(pending.expires_at) > now)) return { ok: false, status: 410, error: 'That code expired. Send a new one.' };
  if (Number(pending.attempts || 0) >= MAX_ATTEMPTS) return { ok: false, status: 429, error: 'Too many tries. Send a new code.' };
  if (!codeMatches(code, pending.code_hash)) {
    const left = MAX_ATTEMPTS - Number(pending.attempts || 0) - 1;
    return { ok: false, status: 400, wrongCode: true,
      error: left > 0 ? "That code doesn't match. Check the text and try again." : 'Too many tries. Send a new code.' };
  }
  return { ok: true };
}

/**
 * Job-text consent follows the Easer to the confirmed number only if they had
 * it. Someone who never turned texts on, or texted STOP, stays that way.
 */
export function consentAfterChange(profile, now = new Date()) {
  if (profile?.sms_consent_at && !profile?.sms_opted_out_at) {
    return { sms_consent_at: now.toISOString(), sms_consent_source: 'phone_change_verified' };
  }
  return {};
}

export function codeText(code) {
  return `AssembleAtEase: your code is ${code}. It expires in 10 minutes.`;
}
