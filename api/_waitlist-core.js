/**
 * _waitlist-core.js — the ONE set of rules for who may go on the Easer waitlist.
 *
 * WHY THIS MODULE EXISTS
 * There are two doors onto the waitlist: the public form (api/waitlist.js) and the
 * owner adding someone by hand (api/owner/waitlist.js). Before this module, only
 * the public door validated anything. A second copy of "is this a real email, a
 * real city, a real state" in the owner handler is exactly the shape Article 3
 * forbids — two places holding one rule, drifting apart the first time one is
 * fixed and the other is not.
 *
 * Both doors now call validateWaitlistInput(). A rule changed here changes for
 * everyone, which is the whole point.
 *
 * WHAT IS DELIBERATELY *NOT* SHARED: whether the person gets emailed. The public
 * form emails a confirmation because they just asked for one. An owner-added
 * person did not ask for anything, so that is an explicit owner decision — see
 * the consent note in api/owner/waitlist.js.
 */

import { normalizeUsPhone } from './_phone.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]);

// ── Disposable / spam email domain blocklist ──────────────────────────────────
export const BLOCKED_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.net','guerrillamail.org',
  'guerrillamail.biz','guerrillamail.de','guerrillamail.info','sharklasers.com',
  'guerrillamailblock.com','grr.la','guerrillamail.de','spam4.me','trashmail.at',
  'trashmail.com','trashmail.io','trashmail.me','trashmail.net','trashmail.org',
  'trashmail.xyz','yopmail.com','yopmail.fr','yopmail.net','cool.fr.nf',
  'jetable.fr.nf','nospam.ze.tc','nomail.xl.cx','mega.zik.dj','speed.1s.fr',
  'courriel.fr.nf','moncourrier.fr.nf','monemail.fr.nf','monmail.fr.nf',
  'tempmail.com','tempmail.net','tempmail.org','tempr.email','temp-mail.org',
  'temp-mail.com','throwam.com','throwam.net','mailnull.com','mailnull.net',
  'spamgourmet.com','spamgourmet.net','spamgourmet.org','spamgourmet.me',
  'dispostable.com','dispostable.net','mailnesia.com','mailnull.com',
  'maildrop.cc','mailsac.com','spaml.com','spaml.de','spamto.de',
  'fakeinbox.com','mailboxy.fun','burnermail.io','throwAwayMail.com',
  'cock.li','airmail.cc','420blaze.it','nwldx.com','ytnef.com',
  'getairmail.com','filzmail.com','throwam.com','incognitomail.com',
  'incognitomail.net','eonjump.com','mailforspam.com','crazymailing.com',
  'binkmail.com','bobmail.info','dayrep.com','einrot.com','fleckens.hu',
  'hochsitze.com','hulapla.de','kingsq.ga','lacedmail.com','lazyinbox.us',
  'letthemeatspam.com','lookugly.com','rppkn.com','sogetthis.com',
  'stuffitnow.com','sweetxxx.de','thisisnotmyrealemail.com','thinktank.us',
  'willhackforfood.biz','teleworm.us','dingbone.com','fudgedrinking.com',
  'onewaymail.com','dontreg.com','dontsendmespam.de','drdrb.com',
  'dump-email.info','email60.com','emailna.com','emailproxsy.com',
  'explodemail.com','fast-email.com','fivemail.de','gowikibooks.com',
  'gowikicampus.com','gowikicars.com','gowikifilms.com','gowikigames.com',
  'gowikimusic.com','gowikinetwork.com','gowikitravel.com','gowikitv.com',
  'hasanmail.ml','hissfame.com','hz.ml','ieatspam.eu','ieatspam.info',
  'inboxalias.com','jnxjn.com','klzlk.com','kyois.com','llogin.com',
  'mail4trash.com','mailbidon.com','mailimate.com','mailmetrash.com',
  'mailmoat.com','mailnew.com','mailscrap.com','mailsiphon.com','notmailinator.com',
  'no-spam.ws','nospam.ze.tc',
]);

export function isDisposableEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  if (BLOCKED_DOMAINS.has(domain)) return true;
  // Catch patterns like "xxxxx@mailinator.net", "xxxxx@yopmail.net" subdomains
  return [...BLOCKED_DOMAINS].some(d => domain.endsWith('.' + d));
}

// ── Location gibberish detection ─────────────────────────────────────────────
export function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function isInvalidHumanText(value) {
  return value.length < 2 || !/[a-z]/i.test(value) || /(.)\1{3,}/i.test(value);
}

// Columns that migration 082 adds. Until it has run, naming them in a write
// makes PostgREST reject the whole statement — which would take down the PUBLIC
// waitlist form, a page the owner is not watching, for a feature they were not
// using yet. The same shape cost this platform twelve hours once already
// (provider_accepted_at, api/_email.js): correct logic, absent column, silent
// failure. Degrading to "saved without the new fields" beats losing the lead.
const OPTIONAL_COLUMNS = ['source', 'zip'];

function isMissingColumnError(error, columns) {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const message = String(error.message || '');
  return columns.some(col => message.includes(col));
}

function withoutOptionalColumns(record) {
  const stripped = { ...record };
  for (const col of OPTIONAL_COLUMNS) delete stripped[col];
  return stripped;
}

export async function saveWaitlistRecord(sb, record) {
  const { data: existing, error: lookupError } = await sb
    .from('assembler_waitlist')
    .select('id, status, name, created_at')
    .eq('email', record.email)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    // Provenance is written once. Someone who signed themselves up stays a
    // public_form row forever, even if the owner later re-adds them by hand —
    // otherwise "did this person actually ask to join us?" stops being answerable.
    const { source: _ignoredSource, ...mutable } = record;

    let degraded = false;
    let { error: updateError } = await sb
      .from('assembler_waitlist').update(mutable).eq('id', existing.id);
    if (isMissingColumnError(updateError, OPTIONAL_COLUMNS)) {
      degraded = true;
      ({ error: updateError } = await sb
        .from('assembler_waitlist').update(withoutOptionalColumns(mutable)).eq('id', existing.id));
    }
    if (updateError) throw updateError;
    return { id: existing.id, status: existing.status, created: false, degraded };
  }

  let degradedInsert = false;
  let { data: inserted, error: insertError } = await sb
    .from('assembler_waitlist')
    .insert({ ...record, status: 'pending' })
    .select('id, status')
    .single();

  if (isMissingColumnError(insertError, OPTIONAL_COLUMNS)) {
    console.warn('[waitlist] migration 082 has not run; saving without source/zip');
    degradedInsert = true;
    ({ data: inserted, error: insertError } = await sb
      .from('assembler_waitlist')
      .insert({ ...withoutOptionalColumns(record), status: 'pending' })
      .select('id, status')
      .single());
  }
  if (insertError) throw insertError;
  // The caller must be able to tell the owner that the ZIP they typed was not
  // stored. Reporting coverage for a ZIP we silently dropped is exactly the
  // unverified assertion Article 16 forbids.
  return { id: inserted.id, status: inserted.status, created: true, degraded: degradedInsert };
}

// ── Where a waitlist row came from ──────────────────────────────────────────
// This is not decoration. "Fourteen people are waiting in Dallas" means something
// completely different if the owner typed all fourteen in himself. Demand signal
// and a to-do list must not look identical in the same table.
export const WAITLIST_SOURCE = Object.freeze({
  PUBLIC_FORM: 'public_form',
  OWNER_ADDED: 'owner_added',
});

const ZIP_RE = /^[0-9]{5}$/;

/**
 * The single gate both waitlist doors pass through.
 * Returns { ok: true, value } or { ok: false, error } — never throws on bad input.
 *
 * ZIP is optional by design: the owner meeting someone at a job site knows their
 * city long before their ZIP, and refusing the name until he has five digits
 * loses the lead. When it IS given it is the only field that answers the question
 * that matters — can we actually dispatch to this person?
 */
export function validateWaitlistInput(body = {}) {
  const name = cleanText(body.name, 120);
  const email = cleanText(body.email, 180).toLowerCase();
  const phone = normalizeUsPhone(cleanText(body.phone, 40));
  const city = cleanText(body.city, 80);
  const state = cleanText(body.state, 2).toUpperCase();
  const zip = cleanText(body.zip, 10);

  if (!name || !EMAIL_RE.test(email) || !phone || !city || !US_STATE_CODES.has(state)) {
    return { ok: false, error: 'Enter a valid name, email, 10-digit U.S. phone number, city, and 2-letter state.' };
  }
  if (isDisposableEmail(email)) {
    return { ok: false, error: 'Please use a real, permanent email address. Disposable or temporary emails are not accepted.' };
  }
  if (isInvalidHumanText(city)) return { ok: false, error: 'Please enter a valid city name.' };
  if (isInvalidHumanText(name)) return { ok: false, error: 'Please enter a real full name.' };
  if (zip && !ZIP_RE.test(zip)) return { ok: false, error: 'ZIP code must be 5 digits.' };

  return { ok: true, value: { name, email, phone, city, state, zip: zip || null } };
}
