// Execute the real endpoint with in-memory persistence/provider dependencies.
// No credentials, network calls, outbound messages, or real link rotations.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildStatusEmail, esc, formatAddress } from '../api/_email.js';
import { formatAppointmentDate, formatSlotShort, appointmentTimeZone } from '../api/booking/_appt-date.js';
import { operationalDate, operationalTime } from '../api/owner/_active-jobs.js';
import { BOOKING_STATUS } from '../api/_source-of-truth.js';
import { notificationDeliveryKey } from '../api/_notification-policy.js';

const source = await readFile(new URL('../api/owner/resend-booking-details.js', import.meta.url), 'utf8');
const runnable = source.replace(/^import [^\r\n]+;\r?$/gm, '').replace('export default async function handler', 'async function handler') + '\nglobalThis.handler = handler;';
const id = '12345678-1234-4234-8234-123456789012';
const requestId = 'fixture-request-0000000001';
const now = Date.parse('2026-09-23T15:00:00Z');
const deliveryKey = request => notificationDeliveryKey('email', 'customer:customer@example.test', `booking-details:${id}:${request}`);
const base = {
  id, ref: 'AAE-FIXTURE', status: 'confirmed', service: 'Furniture Assembly',
  date: '2026-09-24', time: '8 AM-10 AM', address: 'Fixture address',
  customer_name: 'Fixture Customer', customer_email: 'customer@example.test',
  assembler_name: 'Fixture Easer', total_price: 10825, guest_mutation_token_hash: 'hash-deterministic',
};
const plain = value => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
  const state = { booking: { ...base, ...options.booking }, queries: [], updates: [], sent: [], activity: [], leaseAttempts: 0, released: 0, held: false };
  const database = {
    from(table) {
      const q = { table, filters: [], columns: null, patch: null,
        select(columns) { this.columns = columns; return this; },
        eq(field, value) { this.filters.push([field,value]); return this; },
        is(field, value) { this.filters.push([field,value]); return this; },
        update(patch) { this.patch = patch; return this; },
        order() { return this; }, limit() { return this; }, maybeSingle() { return this; },
        then(resolve, reject) {
          state.queries.push({ table, columns: this.columns, filters: this.filters });
          let result;
          if (table === 'bookings' && this.patch) {
            state.updates.push(plain(this.patch));
            if (options.rotationFails) result = { data: [], error: null };
            else { Object.assign(state.booking, this.patch); result = { data: [{ id }], error: null }; }
          } else if (table === 'bookings') result = { data: options.missingBooking ? null : plain(state.booking), error: options.loadError ? { message:'Read failed' } : null };
          else if (table === 'notification_log') {
            const priorQuery = this.filters.some(([field]) => field === 'notification_type');
            result = { data: plain(priorQuery ? options.prior || [] : options.recent || []), error: options.historyError || priorQuery && options.priorError ? { message:'Read failed' } : null };
          } else throw new Error('Unexpected table ' + table);
          return Promise.resolve(result).then(resolve,reject);
        },
      };
      return q;
    },
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    console: { error() {} }, process: { env: { PUBLIC_SITE_URL: 'https://example.test' } }, Date: FixedDate,
    verifyOwner: req => req.owner === true, getSupabase: () => database,
    buildStatusEmail, esc, ownerEmail: () => 'owner@example.test', BOOKING_STATUS,
    formatAppointmentDate, formatSlotShort, appointmentTimeZone, operationalDate, operationalTime, formatAddress, notificationDeliveryKey,
    deriveGuestMutationToken: () => 'deterministic',
    safeTokenHashMatch: (token, hash) => hash === 'hash-' + token,
    randomToken: () => 'fresh-fixture-token', sha256: token => 'hash-' + token,
    guestManageUrl: (booking, site, token) => site + '/track?ref=' + booking.ref + '&token=' + token,
    acquireNotificationLease: async () => {
      state.leaseAttempts++;
      if (state.held || options.leaseBusy) return { ok: false };
      state.held = true;
      return { ok: true, token: 'lease-fixture' };
    },
    releaseNotificationLease: async () => { state.held = false; state.released++; },
    sendEmail: async message => {
      state.sent.push(plain(message));
      return typeof options.send === 'function' ? options.send(message) : options.send || { ok: true, providerAccepted: true };
    },
    logActivity: async (sb, row) => { state.activity.push(plain(row)); },
  });
  vm.runInContext(runnable, context, { filename:'api/owner/resend-booking-details.js' });
  return { state, async call(overrides = {}) {
    const response = { status(code) { this.code = code; return this; }, json(body) { this.body = plain(body); return this; } };
    await context.handler({ method:'POST', owner:true, query:{ bookingId:id }, body:{ bookingId:id, requestId }, ...overrides }, response);
    return response;
  } };
}
const unauthorized = harness();
assert.equal((await unauthorized.call({ owner:false })).code,401);
assert.equal((await unauthorized.call({ method:'DELETE' })).code,405);
assert.equal((await unauthorized.call({ body:{ bookingId:'bad', requestId } })).code,400);
assert.equal(unauthorized.state.queries.length,0);
for (const bad of ['', 'short', '../request-injection', 'x'.repeat(81)]) {
  const api = harness();
  assert.equal((await api.call({ body:{ bookingId:id, requestId:bad } })).code,400);
  assert.equal(api.state.sent.length,0); assert.equal(api.state.updates.length,0);
}
const history = harness({ recent:[
  { notification_type:'booking_details_resend', channel:'email', status:'failed', sent_at:'2026-09-23T14:00:00Z', send_payload:{ secret:'private' } },
  { notification_type:'reminder', channel:'email', status:'delivered', sent_at:'2026-09-23T13:00:00Z' },
  { notification_type:'booking_details_resend', channel:'email', status:'delivered', sent_at:'2026-09-22T12:00:00Z', provider_accepted_at:'2026-09-22T12:00:01Z', delivered_at:'2026-09-22T12:00:02Z' },
] });
const preview = await history.call({ method:'GET' });
assert.equal(preview.code,200);
assert.equal(preview.body.lastDetailsSentAt,'2026-09-22T12:00:01Z');
assert.equal(preview.body.lastDetailsDeliveredAt,'2026-09-22T12:00:02Z');
assert.equal(preview.body.recentNotifications[0].status,'failed');
assert.doesNotMatch(JSON.stringify(preview.body), /send_payload|private|guest_mutation_token/);
assert.equal(history.state.sent.length,0); assert.equal(history.state.updates.length,0); assert.equal(history.state.leaseAttempts,0);

for (const status of ['provider_accepted','sent','delivered','delivery_delayed']) {
  const api = harness({ booking:{ guest_mutation_token_hash:'old-link' }, prior:[{ notification_key:deliveryKey(requestId), status, sent_at:'2026-09-20T12:00:00Z' }] });
  const result = await api.call();
  assert.equal(result.code,200); assert.equal(result.body.alreadySent,true);
  assert.equal(api.state.sent.length,0); assert.equal(api.state.updates.length,0); assert.equal(api.state.activity.length,0);
  assert.equal(api.state.released,1);
}
for (const status of ['queued','deferred','uncertain','failed','cancelled']) {
  const api = harness({ prior:[{ notification_key:deliveryKey(requestId), status, sent_at:'2026-09-20T12:00:00Z' }] });
  assert.equal((await api.call()).code,409);
  assert.equal(api.state.sent.length,0); assert.equal(api.state.updates.length,0);
}
const rapidNew = harness({ prior:[{ notification_key:deliveryKey('older-valid-request'), status:'sent', provider_accepted_at:'2026-09-23T14:59:30Z' }] });
assert.equal((await rapidNew.call()).body.alreadySent,true);
assert.equal(rapidNew.state.sent.length,0); assert.equal(rapidNew.state.updates.length,0);
for (const status of ['queued','deferred','uncertain','failed']) {
  const api = harness({ booking:{ guest_mutation_token_hash:'old-link' }, prior:[{
    notification_key:deliveryKey('older-unresolved-request'), status,
    sent_at:'2026-09-22T12:00:00Z', next_attempt_at:status === 'failed' ? '2026-09-23T15:01:00Z' : null,
  }] });
  assert.equal((await api.call()).code,409, 'A new request ID cannot bypass unresolved prior delivery');
  assert.equal(api.state.sent.length,0); assert.equal(api.state.updates.length,0);
}
const busy = harness({ leaseBusy:true });
assert.equal((await busy.call()).code,409); assert.equal(busy.state.sent.length,0); assert.equal(busy.state.updates.length,0);

let unblock;
const sendGate = new Promise(resolve => { unblock = resolve; });
const concurrent = harness({ send:async () => { await sendGate; return { ok:true }; } });
const firstCall = concurrent.call();
while (!concurrent.state.sent.length) await new Promise(resolve => setImmediate(resolve));
assert.equal((await concurrent.call()).code,409);
unblock();
assert.equal((await firstCall).code,200);
assert.equal(concurrent.state.sent.length,1, 'Concurrent requests send exactly one email');

const success = harness();
const result = await success.call();
assert.equal(result.code,200); assert.equal(result.body.sentTo,base.customer_email); assert.equal(result.body.alreadySent,false);
assert.equal(success.state.activity.length,1); assert.equal(success.state.sent.length,1);
assert.match(success.state.sent[0].html,/Here are the latest details for your booking/);
assert.doesNotMatch(success.state.sent[0].html,/You asked|as of today|nothing is charged today/);
assert.match(success.state.sent[0].html,/8\s*AM.*10\s*AM Central Time/);
const returnVisit = harness({ booking:{ return_visit_required:true, return_visit_date:'2026-09-28', return_visit_time:'1 PM-3 PM',
  service_city:'El Paso', service_zip:'79901', return_visit_remaining_scope:'Attach the safety rails' } });
assert.equal((await returnVisit.call()).code,200);
assert.match(returnVisit.state.sent[0].html,/Return date/);
assert.match(returnVisit.state.sent[0].html,/September 28, 2026/);
assert.match(returnVisit.state.sent[0].html,/1\s*PM.*3\s*PM Mountain Time/);
assert.match(returnVisit.state.sent[0].html,/Attach the safety rails/);
assert.doesNotMatch(returnVisit.state.sent[0].html,/September 24, 2026/);
const selectedBookingFields = returnVisit.state.queries.find(query => query.table === 'bookings').columns.split(',').map(field => field.trim());
for (const field of ['service_city','service_zip','return_visit_required','return_visit_date','return_visit_time','return_visit_remaining_scope']) {
  assert.ok(selectedBookingFields.includes(field), `Email source query must include ${field}`);
}
const unscheduledReturn = harness({ booking:{ return_visit_required:true } });
assert.equal((await unscheduledReturn.call()).code,200);
assert.match(unscheduledReturn.state.sent[0].html,/To be scheduled/);
assert.doesNotMatch(unscheduledReturn.state.sent[0].html,/September 24, 2026/);
assert.equal(success.state.sent[0].meta.notificationKey,`booking-details:${id}:${requestId}`);
assert.equal(success.state.updates.length,0, 'Current deterministic link is reused');
const rotated = harness({ booking:{ guest_mutation_token_hash:'obsolete' } });
assert.equal((await rotated.call()).code,200);
assert.deepEqual(rotated.state.updates,[{ guest_mutation_token_hash:'hash-fresh-fixture-token' }]);
assert.match(rotated.state.sent[0].html,/fresh-fixture-token/);
const rotationRace = harness({ booking:{ guest_mutation_token_hash:'obsolete' }, rotationFails:true });
assert.equal((await rotationRace.call()).code,409); assert.equal(rotationRace.state.sent.length,0);
for (const outcome of [{ ok:false }, { ok:false,deferred:true }, { ok:false,retryScheduled:true }]) {
  const api = harness({ send:outcome });
  const failure = await api.call();
  assert.equal(failure.code,503); assert.ok(failure.body.trackUrl);
  assert.equal(api.state.activity.length,0, 'Provider failure must never become a successful resend activity');
  assert.equal(api.state.released,1);
}
const duplicateSender = harness({ send:{ ok:true,suppressed:true } });
assert.equal((await duplicateSender.call()).body.alreadySent,true);
assert.equal(duplicateSender.state.activity.length,0);
for (const options of [{ historyError:true }, { priorError:true }, { loadError:true }]) {
  const api = harness(options);
  assert.equal((await api.call()).code,503); assert.equal(api.state.sent.length,0); assert.equal(api.state.updates.length,0);
}
if (process.argv.includes('--fixture')) {
  // Fictional, local-only email previews. Only remote image sources are replaced;
  // the production builders' document, styles, copy and links stay intact.
  process.env.GUEST_ACCESS_TOKEN_SECRET = 'local-fixture-only-not-a-live-secret';
  const { buildReminderEmail } = await import('../api/cron/reminders.js');
  const { guestMutationTokenHash } = await import('../api/_payment-security.js');
  const booking = { ...base, ref: 'AAE-FIXTURE24', service: 'Outdoor & Playsets',
    service_city: 'San Antonio', service_zip: '78201', address: '123 Fixture Street, San Antonio, TX 78201' };
  booking.guest_mutation_token_hash = guestMutationTokenHash(booking);
  const preview = html => html.replace(/(<img\b[^>]*\bsrc=")[^"]+("[^>]*>)/gi,
    '$1data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=$2');
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  const fixtures = {
    'customer-reminder': buildReminderEmail({ booking, recipientType: 'customer', firstName: 'Fixture' }),
    'easer-reminder': buildReminderEmail({ booking, recipientType: 'easer', firstName: 'Fixture' }),
    'resend': success.state.sent[0].html,
    'resend-return': returnVisit.state.sent[0].html,
  };
  for (const [name, html] of Object.entries(fixtures)) {
    await writeFile(new URL(`../tmp/notification-email-${name}.html`, import.meta.url), preview(html));
  }
}
console.log('Booking-details resend safety: PASS (read-only preview, authorization, idempotency, concurrency, neutral actual email, token CAS, provider failures)');
