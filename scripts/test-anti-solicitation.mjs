#!/usr/bin/env node
// Nobody joins AssembleAtEase to take its customers (owner, 2026-10-22, "no
// exception, no wiggle room"). Prompted by an application whose About text was
// an advert for the applicant's own TV-mounting company while the disclosure
// answer said "no competing business". This holds the three places that act on
// it: application screening, the blocked-message alert, and the customer's
// post-job question.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { inspectApplicationText, inspectRelayMessage } = await import('../api/booking/_relay-contact-guard.js');
const { recordBlockedRelayAttempt, solicitationSourceRef } = await import('../api/booking/_solicitation-alert.js');

// ── Applications: the real advert is caught, ordinary bios are not ──────────
{
  const advert = 'No competing home-services business disclosed.\n\nLooking for a reliable TV mounting services Pro TV Mount provides professional, secure, and clean TV installations for homes and businesses.\n\nWhat We Offer\nProfessional TV wall mounting\nWire concealment\n\nCall or message Pro TV Mount today for a free estimate and convenient appointment.';
  const screen = inspectApplicationText(advert);
  assert.equal(screen.flagged, true, 'the application that prompted this is flagged');
  const codes = screen.findings.map((f) => f.code);
  assert.ok(codes.includes('business_ad') && codes.includes('free_estimate') && codes.includes('business_offer'), codes.join(','));
  for (const contact of ['Reach me at 512-555-0134 any time', 'Email me: pro@example.com', 'Check www.mymounting.com', 'Owner of Smith Assembly LLC', 'Venmo accepted']) {
    assert.equal(inspectApplicationText(contact).flagged, true, contact);
  }
  for (const ordinary of [
    'No competing home-services business disclosed.\n\nI have 4 years of experience assembling IKEA and Wayfair furniture and mounting TVs. I own my own tools and a truck.',
    'I worked at Home Depot for 3 years. Call me anytime about jobs, I am available weekends.',
    'I did assembly for TaskRabbit for two years and mounted over 200 TVs. Reliable and on time.',
    'Former handyman, I can do furniture, TVs up to 85 inches, and smart doorbells. I take pride in clean work.',
  ]) {
    assert.equal(inspectApplicationText(ordinary).flagged, false, ordinary);
  }
}
console.log('PASS applications: an advert or contact details is flagged; an ordinary bio is not');

// ── Approval waits for the owner's confirmed review ─────────────────────────
{
  const update = read('api/assembler/update.js');
  assert.match(update, /const applicationScreen = inspectApplicationText\(rawProfile\.bio\);\n    if \(applicationScreen\.flagged && req\.body\?\.solicitationReviewed !== true\) \{/);
  assert.match(update, /code: 'APPLICATION_SOLICITATION_REVIEW'/);
  assert.ok(update.indexOf('APPLICATION_SOLICITATION_REVIEW') < update.indexOf("const decision = 'approve';"), 'checked before the approval is claimed');
  assert.match(read('api/assembler/list.js'), /applicationScreen: inspectApplicationText\(profile\.bio\)/, 'the dashboard gets the server verdict');
  const owner = read('owner/index.html');
  assert.equal((owner.match(/d\.code === 'APPLICATION_SOLICITATION_REVIEW'/g) || []).length, 2, 'both approve buttons ask for confirmation');
  assert.match(owner, /a\.applicationScreen && a\.applicationScreen\.flagged/, 'the applicant panel shows the warning');
  const apply = read('api/assembler/apply.js');
  assert.match(apply, /'Review needed: possible own business - '/, 'the new-application email subject says so');
  assert.match(apply, /\$\{screenBanner\}/);
}
console.log('PASS approval: a flagged application needs the owner to confirm the review; the dashboard and email show why');

// ── Messages: every blocked attempt reaches the owner ───────────────────────
{
  for (const ok of ['Running about 15 minutes late, see you soon', 'I will arrive at 10:30, is the gate code 4521?', 'I can do one or two more items if you have them', 'Building 3, unit 2, second floor']) {
    assert.equal(inspectRelayMessage(ok).ok, true, ok);
  }
  for (const dodge of ['five one two five five five 0134', 'text me 5 1 2 5 5 5 0 1 3 4', 'pay me on zelle']) {
    assert.equal(inspectRelayMessage(dodge).ok, false, dodge);
  }
  const blocked = inspectRelayMessage('Call me at 512 555 0134 and I can do it cheaper');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /was not sent/);
  assert.match(blocked.error, /AssembleAtEase has been notified/);

  const booking = { id: 'b-1', ref: 'AAE-TEST1', customer_name: 'Pat Doe' };
  const created = []; const appended = []; const emails = []; const events = [];
  let openCases = [];
  const sb = {
    from(table) {
      const chain = {
        select() { return chain; }, eq() { return chain; }, not() { return chain; }, limit() { return Promise.resolve({ data: table === 'operations_cases' ? openCases : [] }); },
        maybeSingle() { return Promise.resolve({ data: { full_name: 'Test Easer' } }); },
      };
      return chain;
    },
  };
  const deps = {
    createOperationCase: async (_sb, input) => { created.push(input); return { id: 'case-1', case_ref: 'OP-TEST-1' }; },
    appendOperationCaseEvent: async (_sb, input) => { appended.push(input); },
    sendEmail: async (message) => { emails.push(message); return { ok: true }; },
    recordOperationalEvents: async (_sb, rows) => { events.push(...rows); return { ok: true }; },
  };
  const first = await recordBlockedRelayAttempt(sb, { booking, easerId: 'e-1', messageText: 'Call me at 512 555 0134', inspection: blocked, deps });
  assert.equal(first.created, true);
  assert.equal(created[0].severity, 'critical');
  assert.equal(created[0].caseType, 'account');
  assert.equal(created[0].easerId, 'e-1');
  assert.equal(created[0].bookingId, 'b-1');
  assert.equal(created[0].sourceRef, solicitationSourceRef('e-1', 'b-1'));
  assert.match(created[0].description, /512 555 0134/, 'the owner sees the exact text');
  assert.equal(emails.length, 1, 'the owner is emailed on the first attempt');
  assert.match(emails[0].subject, /Customer contact blocked: Test Easer on AAE-TEST1/);
  assert.equal(events[0].event_type, 'easer_contact_share_blocked');

  openCases = [{ id: 'case-1', case_ref: 'OP-TEST-1' }];
  const again = await recordBlockedRelayAttempt(sb, { booking, easerId: 'e-1', messageText: 'five one two five five five 0134', inspection: blocked, deps });
  assert.equal(again.created, false);
  assert.equal(appended.length, 1, 'a later attempt is added to the open case');
  assert.equal(emails.length, 1, 'and does not email again');

  const message = read('api/booking/message.js');
  const guard = message.indexOf('const inspection = inspectRelayMessage(messageText);');
  const alert = message.indexOf('await recordBlockedRelayAttempt(sb, {', guard);
  const refusal = message.indexOf("return res.status(422).json({ error: inspection.error, code: inspection.code });", guard);
  assert.ok(guard > 0 && alert > guard && alert < refusal, 'every refusal is recorded before it is returned');
}
console.log('PASS messages: a blocked attempt opens a critical case and emails the owner; repeats join the case');

// ── Customers are asked ─────────────────────────────────────────────────────
assert.match(read('api/_review-email.js'), /Did your pro offer to work with you directly, outside AssembleAtEase\? Reply to this email and tell us\./);
console.log('PASS customers: the review email asks whether the pro offered to work directly');

console.log('\nAnti-solicitation tests passed.');
