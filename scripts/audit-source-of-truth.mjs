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
