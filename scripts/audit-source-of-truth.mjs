#!/usr/bin/env node
// Source-of-truth drift audit.
//
// Every inconsistency hit in production this session had one shape: a value that
// exists canonically in a source-of-truth module was ALSO typed by hand somewhere
// else, and the two drifted apart. The Edit Booking service list offered 4 of 7
// services. The owner Job Readiness panel showed 6 of 9 gates. The dispatch error
// invented a cause instead of printing the server's. add-easer.js wrote a fee
// combination the approval check rejects.
//
// This audits that class directly: for each domain below it reads the CANONICAL
// definition, then reports every place the same knowledge is restated by hand.
//
// It reports LOCATIONS, not just counts, and separates:
//   FAIL  — a duplicate that is already out of sync (a live bug)
//   WARN  — a duplicate that currently agrees but will drift the moment the
//           canonical source changes, because nothing links them
//   PASS  — the consumer reads the canonical source
//
// Run: node scripts/audit-source-of-truth.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

function walk(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (['node_modules', '.git', '_prev_', '__pycache__', '_local_artifacts'].includes(e)) continue;
    const full = join(dir, e);
    let s; try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full, exts, out);
    else if (exts.some(x => e.endsWith(x))) out.push(full);
  }
  return out;
}

const FRONTEND = [
  join(ROOT, 'owner'), join(ROOT, 'assembler'),
].flatMap(d => walk(d, ['.html', '.js']))
  .concat(['book.html', 'track.html', 'index.html'].map(f => join(ROOT, f)))
  .filter(f => { try { statSync(f); return true; } catch { return false; } });

const findings = [];
function report(level, domain, detail, locations = []) {
  findings.push({ level, domain, detail, locations });
}

function linesMatching(file, re) {
  const out = [];
  const src = readFileSync(file, 'utf8');
  src.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|<!--)/.test(line)) return;
    re.lastIndex = 0;
    if (re.test(line)) out.push(`${rel(file)}:${i + 1}`);
  });
  return out;
}

// ── 1. Service catalog ───────────────────────────────────────────────────────
{
  const g = {};
  const catalogSrc = readFileSync(join(ROOT, 'assets/js/booking-source-of-truth.js'), 'utf8');
  new Function('window', catalogSrc)(g);
  const services = Object.keys(g.AAE_BOOKING_SOURCE?.subcategories || {});
  report('INFO', 'Service catalog', `Canonical: ${services.length} services — ${services.join(', ')}`);

  for (const file of FRONTEND) {
    const src = readFileSync(file, 'utf8');
    if (src.includes('booking-source-of-truth.js') || src.includes('AAE_BOOKING_SOURCE')) {
      report('PASS', 'Service catalog', `reads the canonical catalog`, [rel(file)]);
      continue;
    }
    // A hand-typed <option> list of service names is duplicated truth.
    const optionBlocks = [...src.matchAll(/<option[^>]*>([^<]{3,60})<\/option>/g)].map(m => m[1].trim());
    const hits = optionBlocks.filter(v => services.some(s => s.replace(/&/g, '&amp;') === v || s === v));
    if (hits.length) {
      const missing = services.filter(s => !hits.includes(s) && !hits.includes(s.replace(/&/g, '&amp;')));
      report(missing.length ? 'FAIL' : 'WARN', 'Service catalog',
        missing.length
          ? `hardcoded service <option> list is MISSING ${missing.length}: ${missing.join(', ')}`
          : `hardcoded service <option> list currently matches but is not linked to the catalog`,
        linesMatching(file, /<option[^>]*>[A-Z]/));
    }
  }
}

// ── 2. Booking status enum ───────────────────────────────────────────────────
{
  const sot = readFileSync(join(ROOT, 'api/_source-of-truth.js'), 'utf8');
  const block = sot.match(/export const BOOKING_STATUS = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
  const statuses = [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  report('INFO', 'Booking status', `Canonical: ${statuses.join(', ')}`);

  // The browser mirror must stay byte-identical to the server enum. This is the
  // enforceable half: pages have no bundler and cannot import the server module,
  // so one mirror file is the best achievable single source — but only if
  // something FAILS the moment it drifts.
  const mirrorPath = join(ROOT, 'assets/js/status-source-of-truth.js');
  let mirror = null;
  try {
    const g = {};
    new Function('window', readFileSync(mirrorPath, 'utf8'))(g);
    mirror = g.AAE_STATUS;
  } catch (e) {
    report('FAIL', 'Booking status', `browser status mirror failed to load: ${e.message}`, ['assets/js/status-source-of-truth.js']);
  }
  if (mirror) {
    const mirrored = Object.values(mirror.BOOKING);
    const missing = statuses.filter(s => !mirrored.includes(s));
    const extra = mirrored.filter(s => !statuses.includes(s));
    if (missing.length || extra.length) {
      report('FAIL', 'Booking status',
        `browser mirror is OUT OF SYNC with _source-of-truth.js — missing: [${missing.join(', ') || 'none'}], unknown: [${extra.join(', ') || 'none'}]`,
        ['assets/js/status-source-of-truth.js']);
    } else {
      report('PASS', 'Booking status', `browser mirror matches all ${statuses.length} canonical statuses`, ['assets/js/status-source-of-truth.js']);
    }
    // Any status literal used in a page must be a REAL status. This catches the
    // typo/renamed-status class even where literals remain inline.
    const known = new Set([...statuses, ...Object.values(mirror.EASER_ACCOUNT), ...Object.values(mirror.EASER_APPLICATION), ...Object.values(mirror.DISPATCH_OFFER)]);
    for (const file of FRONTEND) {
      const src = readFileSync(file, 'utf8');
      // Scope tightly to BOOKING objects. A bare `status` also names social-post,
      // cron-log, Stripe-intent, waitlist and UI-filter states; matching those
      // produced pure noise on the first pass and a noisy audit gets ignored.
      const used = new Set([...src.matchAll(/\b(?:b|booking|bk|bObj|item|row)\.(?:status|payment_status|dispatch_status)\s*(?:===?|!==?)\s*'([a-z_]+)'/g)].map(m => m[1]));
      const bogus = [...used].filter(v => !known.has(v) && !['card_saved','authorized','captured','failed','refunded','partially_refunded','not_required','deposit_paid','offline_recorded','quote_pending_approval','quote_authorization_pending','cancellation_fee_captured','pending_payment','payment_hold','offered','paid','transferred','unpaid','on_hold','review_required','approved_full'].includes(v));
      if (bogus.length) {
        report('FAIL', 'Booking status', `compares a status against value(s) no enum defines: ${bogus.join(', ')}`, [rel(file)]);
      }
    }
    for (const file of FRONTEND) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('status-source-of-truth.js') && !src.includes('AAE_STATUS')) {
        const found = statuses.filter(s => new RegExp(`['"]${s}['"]`).test(src));
        if (found.length >= 5) {
          report('WARN', 'Booking status',
            `restates ${found.length}/${statuses.length} statuses and does not load the shared status mirror`,
            [rel(file)]);
        }
      }
    }
  }
}

// ── 3. Money constants ───────────────────────────────────────────────────────
{
  const sot = readFileSync(join(ROOT, 'api/_source-of-truth.js'), 'utf8');
  const consts = {
    'SALES_TAX_RATE': (sot.match(/SALES_TAX_RATE = ([\d.]+)/) || [])[1],
    'SAME_DAY_FEE_CENTS': (sot.match(/SAME_DAY_FEE_CENTS = (\d+)/) || [])[1],
    'SAME_DAY_EASER_BONUS_CENTS': (sot.match(/SAME_DAY_EASER_BONUS_CENTS = (\d+)/) || [])[1],
  };
  const feeBlock = sot.match(/MEMBERSHIP_PLATFORM_FEE_PCT = Object\.freeze\(\{([\s\S]*?)\}\)/);
  const feePcts = feeBlock ? [...feeBlock[1].matchAll(/([\d.]+)/g)].map(m => m[1]) : [];
  report('INFO', 'Money constants',
    `Canonical: tax ${consts.SALES_TAX_RATE}, same-day $${consts.SAME_DAY_FEE_CENTS / 100}, easer bonus $${consts.SAME_DAY_EASER_BONUS_CENTS / 100}, platform fee ${feePcts.join('/')}`);

  // Only PROSE percentages count. A first pass matched bare numbers and drowned in
  // CSS pixel values, animation keyframes, gradient stops, and input placeholders —
  // none of which are money. Strip tags/attributes first, then look for a percent
  // literal that is actually a rate the platform states to someone.
  const taxPct = String(Number(consts.SALES_TAX_RATE) * 100);           // "8.25"
  const feeSet = new Set(feePcts.map(String));                           // "25","30"
  const easerShare = new Set(feePcts.map(p => String(100 - Number(p)))); // "75","70"

  for (const file of FRONTEND) {
    // The contractor agreement is a SIGNED document whose text must stay frozen
    // per version. Its percentages are owned by the dedicated agreement check
    // above, which fails if they stop matching the live split — flagging them
    // here too would just be a second voice saying the same thing.
    if (/contractor-agreement\.html$/.test(file)) continue;

    // Blank out <style> blocks entirely — keyframe stops like `30%{...}` and
    // gradient stops are percentages, but they are not money.
    const raw = readFileSync(file, 'utf8').replace(/<style[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, ' '));
    const lines = raw.split(/\r?\n/);
    const locs = { tax: [], fee: [] };
    lines.forEach((line, i) => {
      // Drop tags and attribute values so CSS and placeholders cannot match.
      const prose = line.replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' ');
      // A line already bound to the shared rates mirror is the fix, not the
      // problem — the visible number there is a deliberate no-JS fallback that
      // gets overwritten at runtime.
      if (/AAE_RATES|tax-rate-label/.test(line)) return;
      const pcts = [...prose.matchAll(/(\d{1,3}(?:\.\d{1,2})?)\s?%/g)].map(m => m[1]);
      if (!pcts.length) return;
      if (pcts.includes(taxPct)) locs.tax.push(`${rel(file)}:${i + 1}`);
      if (pcts.some(p => feeSet.has(p) || easerShare.has(p))) locs.fee.push(`${rel(file)}:${i + 1}`);
    });
    if (locs.tax.length) {
      report('WARN', 'Money constants',
        `states the ${taxPct}% sales-tax rate as fixed copy — matches SALES_TAX_RATE today, but nothing updates it if the rate changes`,
        locs.tax);
    }
    if (locs.fee.length) {
      report('WARN', 'Money constants',
        `states the platform-fee split as fixed copy — matches getPlatformFeePct() today, but nothing updates it if the split changes`,
        locs.fee);
    }
  }
}

// ── 4. Easer readiness gates ─────────────────────────────────────────────────
{
  const rd = readFileSync(join(ROOT, 'api/_easer-readiness.js'), 'utf8');
  const gates = [...rd.matchAll(/if \(!?flags\.([A-Za-z]+)\)[^\n]*missingItems\.push/g)].map(m => m[1]);
  const extra = [...rd.matchAll(/if \(requireAvailability && !flags\.([A-Za-z]+)\)/g)].map(m => m[1]);
  const all = [...new Set([...gates, ...extra])];
  report('INFO', 'Easer readiness', `Canonical gates (${all.length}): ${all.join(', ')}`);

  const ownerSrc = readFileSync(join(ROOT, 'owner/index.html'), 'utf8');
  const panel = ownerSrc.match(/var rows = \[([\s\S]*?)\]\.concat/);
  const shown = panel ? [...panel[1].matchAll(/r\.([A-Za-z]+)/g)].map(m => m[1]) : [];
  const hidden = all.filter(g => !shown.includes(g));
  report(hidden.length ? 'FAIL' : 'PASS', 'Easer readiness',
    hidden.length
      ? `owner Job Readiness panel does not display ${hidden.length} gate(s) that block dispatch: ${hidden.join(', ')}`
      : `owner panel displays every canonical readiness gate`,
    ['owner/index.html']);
}

// ── 4b. Contractor agreement vs the live fee split ───────────────────────────
// The agreement is a SIGNED legal document. Rendering its percentages
// dynamically would be wrong — an Easer signed a specific version stating a
// specific split, and that text must stay frozen. The correct control is the
// reverse: if the platform fee ever changes, this FAILS, forcing a new
// CONTRACTOR_AGREEMENT_VERSION and re-acceptance rather than silently leaving
// every Easer holding an agreement that no longer describes what they are paid.
{
  const sot = readFileSync(join(ROOT, 'api/_source-of-truth.js'), 'utf8');
  const standardFee = (sot.match(/NON_MEMBER:\s*([\d.]+)/) || [])[1];
  const agreementPath = join(ROOT, 'assembler/contractor-agreement.html');
  const agreement = readFileSync(agreementPath, 'utf8').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const version = (readFileSync(join(ROOT, 'api/_assembler-onboarding.js'), 'utf8')
    .match(/CONTRACTOR_AGREEMENT_VERSION = '([^']+)'/) || [])[1];

  if (standardFee) {
    const statesFee = new RegExp(`(?<![\\d.])${standardFee}\\s?%`).test(agreement.replace(/<[^>]*>/g, ' '));
    const statesShare = new RegExp(`(?<![\\d.])${100 - Number(standardFee)}\\s?%`).test(agreement.replace(/<[^>]*>/g, ' '));
    report(statesFee && statesShare ? 'PASS' : 'FAIL', 'Contractor agreement',
      statesFee && statesShare
        ? `agreement ${version} states ${standardFee}% / ${100 - Number(standardFee)}%, matching getPlatformFeePct() — no re-acceptance owed`
        : `agreement ${version} does NOT state the live ${standardFee}%/${100 - Number(standardFee)}% split. Easers are working under terms that no longer match what they are paid — publish a new CONTRACTOR_AGREEMENT_VERSION and require re-acceptance.`,
      ['assembler/contractor-agreement.html', 'api/_assembler-onboarding.js']);
  }
}

// ── 4c. Easer acceptance decided in more than one place ──────────────────────
// "The booking is confirmed" and "the Easer accepted" are different facts. The
// Easer Availability widget mapped booking status 'confirmed' straight to
// "Accepted" and contradicted the booking detail on the same screen. Acceptance
// must be answered by exactly one rule.
{
  const ownerSrc = readFileSync(join(ROOT, 'owner/index.html'), 'utf8');
  const helper = /function easerHasAccepted\(/.test(ownerSrc);
  // Any inline re-derivation of acceptance outside the helper is a second copy.
  const inline = [];
  let insideHelper = false;
  ownerSrc.split(/\r?\n/).forEach((line, i) => {
    // The helper's own body is the one legitimate place the rule is written out.
    if (/function easerHasAccepted\(/.test(line)) { insideHelper = true; return; }
    if (insideHelper) { if (/^\s{0,2}\}/.test(line)) insideHelper = false; return; }
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/assembler_accepted_at/.test(line) && /dispatch_status/.test(line)) inline.push(`owner/index.html:${i + 1}`);
    // Mapping a booking status directly onto an acceptance word.
    if (/confirmed\s*:\s*'Accepted'/.test(line) && !/booking_accepted/.test(ownerSrc)) inline.push(`owner/index.html:${i + 1}`);
  });
  report(!helper ? 'FAIL' : (inline.length ? 'FAIL' : 'PASS'), 'Easer acceptance',
    !helper
      ? 'no single easerHasAccepted() rule — acceptance is decided ad hoc'
      : (inline.length
        ? `acceptance is re-derived outside easerHasAccepted() in ${inline.length} place(s)`
        : 'every display reads the one easerHasAccepted() rule, and live-ops ships booking_accepted from the server'),
    inline.length ? inline : ['owner/index.html', 'api/owner/live-ops.js']);
}

// ── 4d. Booking items / add-ons read through the one loader ──────────────────
// The owner priced a quote without the customer's floor levelling, placement
// support and safety anchoring because api/booking/my-assignments.js queried
// booking_items (2026-06-17) and api/booking/list.js never did. Two roles, two
// answers, ~2.5 months and 318 commits before anyone noticed — and it surfaced
// as money quoted below the real scope.
//
// api/booking/_booking-items.js is now the only place that READS the table for
// display. This fails the build if a new consumer queries it directly, which is
// exactly how the gap opened the first time.
{
  const LOADER = 'api/booking/_booking-items.js';
  // Writers and destructive maintenance are not display consumers.
  // The boundary: the loader owns PER-BOOKING DISPLAY SCOPE — what the owner and
  // the Easer each see on a job. Those two must never disagree, which is what
  // this guard protects. Everything below reads the table for a different
  // purpose and is allowlisted deliberately, not by omission.
  const ALLOWED_DIRECT = new Set([
    LOADER,                              // the loader itself
    'api/booking.js',                    // INSERTs the rows at booking time
    // Aggregate revenue analytics: attach rate, add-on revenue, service
    // profitability. Selects add_on_revenue / base_service_revenue, which the
    // display loader deliberately does not expose, and shows nobody a job's
    // scope — so it cannot cause an owner/Easer mismatch. Routing an aggregate
    // through a per-booking display loader would be worse coupling, not better.
    'api/owner/financial-dashboard.js',
  ]);
  const offenders = [];
  for (const file of walk(join(ROOT, 'api'), ['.js'])) {
    const path = rel(file);
    if (ALLOWED_DIRECT.has(path)) continue;
    const src = readFileSync(file, 'utf8');
    // A real query, not a table name in a cleanup list.
    if (/\.from\(\s*['"]booking_items['"]\s*\)\s*\.\s*(select|update|upsert)/.test(src)) {
      offenders.push(path);
    }
  }
  const consumers = ['api/booking/list.js', 'api/booking/my-assignments.js']
    .filter(p => /loadBookingItems\(/.test(readFileSync(join(ROOT, p), 'utf8')));

  report(offenders.length ? 'FAIL' : 'PASS', 'Booking items',
    offenders.length
      ? `read booking_items directly instead of through ${LOADER} — the owner and the Easer can drift apart again: ${offenders.join(', ')}`
      : `every display consumer reads through ${LOADER} (${consumers.length}/2 wired: ${consumers.join(', ')})`,
    offenders.length ? offenders : [LOADER]);

  if (consumers.length !== 2) {
    report('FAIL', 'Booking items',
      'the owner list and the Easer assignments API must BOTH use loadBookingItems — if only one does, they show different scope',
      ['api/booking/list.js', 'api/booking/my-assignments.js']);
  }
}

// ── 4e. Un-assigning must always un-pause ───────────────────────────────────
// api/booking/assign.js sets dispatch_paused = true when an Easer is assigned,
// so auto-dispatch does not compete for a job that already has someone. Any path
// that clears assembler_id therefore OWNS clearing that pause too. Release and
// Decline both forgot, which left bookings unassigned AND paused: Smart Dispatch
// refused with "Dispatch is paused on this booking" — a pause the owner never
// set, on a job with nobody on it. Stranded, with a misleading reason.
{
  const unassigners = ['api/booking/release-assignment.js', 'api/booking/decline-dispatch.js'];
  const offenders = [];
  for (const path of unassigners) {
    const src = readFileSync(join(ROOT, path), 'utf8');
    // Does it clear the assignment at all?
    if (!/assembler_id:\s*null/.test(src)) continue;
    if (!/dispatch_paused:\s*false/.test(src)) offenders.push(path);
  }
  report(offenders.length ? 'FAIL' : 'PASS', 'Dispatch pause',
    offenders.length
      ? `clears assembler_id without clearing dispatch_paused — the booking is left unassigned AND paused, and Smart Dispatch refuses on a pause nobody set: ${offenders.join(', ')}`
      : 'every path that un-assigns a booking also clears dispatch_paused, so a freed job is immediately dispatchable',
    offenders.length ? offenders : unassigners);
}

// ── 4f. A notification channel that is imported but never sent ───────────
//
// api/booking/_dispatch-internal.js imported sendSms and never called it. Auto-
// dispatch — the path that offers almost every job — sent email and push but no
// text, while manual assignment did. Nothing failed: the import parsed, the file
// linted, every test passed. The feature was simply absent, silently, for every
// offer.
//
// Two halves must both be present, and each is useless alone:
//   1. the channel is actually CALLED, not merely imported
//   2. the recipient projection SELECTS the consent columns — without them
//      smsEligibility() reads an undefined sms_consent_at and suppresses every
//      send as "no_consent_recorded", which looks exactly like a compliance
//      refusal rather than a missing column.
{
  const senders = [
    { fn: 'sendSms',        module: '_sms.js',  needs: ['sms_consent_at', 'sms_opted_out_at'] },
    { fn: 'sendPushToUser', module: '_push.js', needs: [] },
  ];
  const offenders = [];
  const checked = [];
  for (const file of walk(join(ROOT, 'api'), ['.js'])) {
    const src = readFileSync(file, 'utf8');
    for (const { fn, needs } of senders) {
      // Deliberately string matching, not regex: a backslash inside a JS template
      // literal is an escape, so `\s` silently becomes `s` and the pattern matches
      // nothing while still "passing". That exact trap produced a green check here
      // on the first attempt.
      const importsFn = src.split(/\r?\n/).some(line => {
        const t = line.trimStart();
        return t.startsWith('import') && t.includes(fn) && t.includes('from');
      });
      if (!importsFn) continue;
      checked.push(`${rel(file)} -> ${fn}`);
      // A call, not just the import line.
      if (!src.includes(`${fn}(`)) {
        offenders.push(`${rel(file)}: imports ${fn} but never calls it`);
        continue;
      }
      // Consent columns must be in a projection somewhere in the file.
      const missing = needs.filter(col => !src.includes(col));
      if (missing.length) {
        offenders.push(`${rel(file)}: calls ${fn} but never selects ${missing.join(', ')} — every send suppresses as no_consent_recorded`);
      }
    }
  }
  report(offenders.length ? 'FAIL' : 'PASS', 'Notification channels',
    offenders.length
      ? `a channel is wired up but cannot deliver: ${offenders.join('; ')}`
      : `every file importing a send function calls it and selects the columns that send needs (${checked.length} import sites)`,
    offenders.length ? offenders : checked);
}

// ── 5. Server error/reason text discarded by the UI ──────────────────────────
{
  const ownerSrc = readFileSync(join(ROOT, 'owner/index.html'), 'utf8');
  const dispatchMsgs = [...readFileSync(join(ROOT, 'api/booking/_dispatch-internal.js'), 'utf8')
    .matchAll(/message: '([^']+)'/g)].map(m => m[1]);
  report('INFO', 'Server reason text', `Dispatch returns ${dispatchMsgs.length} distinct reasons`);
  const surfaced = dispatchMsgs.filter(m => ownerSrc.includes(m));
  report(surfaced.length === 0 ? 'FAIL' : (surfaced.length < dispatchMsgs.length ? 'WARN' : 'PASS'),
    'Server reason text',
    `owner dashboard surfaces ${surfaced.length}/${dispatchMsgs.length} dispatch reasons; the rest are replaced by generic text`,
    ['owner/index.html']);
}

// ── 6. Status values written by code vs DB CHECK constraints ─────────────────
// (delegated to the dedicated drift guard; reported here for completeness)

// ── Output ───────────────────────────────────────────────────────────────────
const order = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 };
findings.sort((a, b) => order[a.level] - order[b.level]);

const counts = findings.reduce((m, f) => ((m[f.level] = (m[f.level] || 0) + 1), m), {});
console.log('\n══ SOURCE-OF-TRUTH AUDIT ══\n');
for (const f of findings) {
  const tag = f.level.padEnd(4);
  console.log(`[${tag}] ${f.domain} — ${f.detail}`);
  for (const l of f.locations.slice(0, 8)) console.log(`         ${l}`);
  if (f.locations.length > 8) console.log(`         …and ${f.locations.length - 8} more`);
}
console.log(`\nFAIL ${counts.FAIL || 0} · WARN ${counts.WARN || 0} · PASS ${counts.PASS || 0}\n`);
process.exit(counts.FAIL ? 1 : 0);
