import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  enrichUnacceptedAssignments,
  redactAssignmentCustomerData,
  deriveOfferLocation,
} from '../api/booking/my-assignments.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const ADDR = '14 BURGESS BEND WAY, SPRING, TX 77389';
const NOW = Date.parse('2026-09-16T12:00:00Z');
const base = { date: '2026-09-24', time: '8:00 AM - 10:00 AM', address: ADDR };

function prepare(rows, offerMap = {}) {
  enrichUnacceptedAssignments(rows, offerMap);
  redactAssignmentCustomerData(rows, NOW);
  return rows;
}

// ── The owner-assigned job that printed "Address TBD" ──────────────────────
// assign.js creates no dispatch_offers row and cancels open ones, so keying the
// city on an offer left this job with neither a street nor a city.
const [owner] = prepare([{ ...base, id: 'owner', status: 'confirmed', assembler_accepted_at: null, assignment_token: 't' }]);
assert.equal(owner.address, null, 'the street stays withheld until acceptance');
assert.equal(owner._offer_location, 'Spring, TX 77389', 'an owner-assigned job must carry its city');
assert.equal(owner._needs_acceptance, true, 'and the verdict that it still needs this pro');
assert.equal(owner._offer_token, undefined, 'offer-only fields come only from a real offer');

// Same answer the assignment email gives, from the same function.
assert.equal(owner._offer_location, deriveOfferLocation(ADDR),
  'the email and the app must never disagree about where a job is');

// ── A job that came from an auto-dispatch offer keeps its offer fields ─────
const [offered] = prepare(
  [{ ...base, id: 'offered', status: 'confirmed', assembler_accepted_at: null }],
  { offered: { expires_at: '2026-09-16T13:00:00Z', token: 'tok', dispatch_score: 7 } },
);
assert.equal(offered._offer_location, 'Spring, TX 77389');
assert.equal(offered._offer_token, 'tok');
assert.equal(offered._offer_expires_at, '2026-09-16T13:00:00Z');

// ── Accepted: full street, no marker ───────────────────────────────────────
const [accepted] = prepare([{ ...base, id: 'accepted', status: 'confirmed', assembler_accepted_at: '2026-09-16T11:00:00Z' }]);
assert.equal(accepted.address, ADDR, 'an accepted job shows its street');
assert.notEqual(accepted._needs_acceptance, true, 'an accepted job must not say it needs accepting');
assert.equal(accepted._offer_location, undefined);

// ── Terminal and never-accepted: nothing to act on, nothing extra sent ─────
const [cancelled] = prepare([{ ...base, id: 'cancelled', status: 'cancelled', assembler_accepted_at: null }]);
assert.equal(cancelled._needs_acceptance, false);
assert.equal(cancelled._offer_location, undefined, 'a dead job does not need its location sent');

// ── Free text in the address is still never echoed ─────────────────────────
const [freeText] = prepare([{ ...base, id: 'ft', status: 'confirmed', assembler_accepted_at: null,
  address: '1 Main St, Private Person, TX 78701' }]);
assert.equal(freeText._offer_location, 'TX 78701');
assert.doesNotMatch(freeText._offer_location, /Private|Person/i);

// ── The home screen renders the verdict and the city ───────────────────────
const home = await read('assembler/index.html');
assert.match(home, /b\.address \? APP\.formatPostalAddress\(b\.address\) : \(b\._offer_location \|\| 'Address TBD'\)/,
  'the home card must fall back to the city before it falls back to TBD');
assert.doesNotMatch(home, /esc\(b\.address\?APP\.formatPostalAddress\(b\.address\):'Address TBD'\)/,
  'the old address-or-TBD line must not come back');
assert.match(home, /var needsAcceptance = b\._needs_acceptance === true;/,
  'the home card must render the server verdict, not work it out itself');
assert.match(home, /Tap to accept/);
assert.match(home, /\/assembler\/my-assignments\?job=' \+ encodeURIComponent\(b\.id\)/,
  '"Tap to accept" must open that job, not the whole list');
assert.match(home, /\.eh-upcoming-needs\{/);

// ── The jobs list card shows the city too ──────────────────────────────────
const jobs = await read('assembler/my-assignments.html');
assert.match(jobs, /!b\.assembler_accepted_at && !isCompleted && b\._offer_location \? b\._offer_location : ''/,
  'the jobs list must show the city for an unaccepted job instead of nothing');

// ── The jobs page deep link still never auto-accepts ───────────────────────
assert.match(jobs, /params\.get\('job'\)/);
assert.match(jobs, /NEVER auto-accept/);

console.log('Easer offer location parity tests: PASS');
