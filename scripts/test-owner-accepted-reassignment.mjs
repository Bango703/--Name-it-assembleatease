// Execute the real assignment handler and owner assignment controls with mocked
// persistence/providers. No credentials, network, live assignments, or messages.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, describeDispatchPaymentBlock, computeBookingSplitFromSnapshot } from '../api/_source-of-truth.js';
import { getEaserReadiness, readinessError } from '../api/_easer-readiness.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { normalizeAssemblerTier } from '../api/_assembler-state.js';
import { buildEaserFeeSnapshot } from '../api/booking/_easer-fee-snapshot.js';
import { describeAssignmentGuardFailure } from '../api/booking/_assignment-guard-reasons.js';
import { isOwnerManualLiveFlow } from '../api/_owner-easer.js';
import * as dates from '../api/booking/_appt-date.js';

const plain = value => JSON.parse(JSON.stringify(value));
const source = await readFile(new URL('../api/booking/assign.js', import.meta.url), 'utf8');
const runnable = source.replace(/^\uFEFF/, '').replace(/^import [^\r\n]+;\r?$/gm, '')
  .replace('export default async function handler', 'async function handler')
  .replaceAll('export const ', 'const ').replaceAll('export function ', 'function ') + '\nglobalThis.handler = handler;';
const base = {
  id:'booking-fixture', ref:'AAE-FIXTURE', source:'website', status:'confirmed',
  assembler_id:'old-easer', assembler_name:'Previous Easer', assigned_at:'2026-09-20T12:00:00Z',
  assembler_accepted_at:'2026-09-20T13:00:00Z', dispatch_status:'accepted', assignment_token:'old-token',
  financial_operation_key:null, financial_operation_type:null, financial_operation_started_at:null,
  payment_status:'authorized', total_price:21650, tax_amount:1650, stripe_payment_intent_id:'pi_fixture',
  stripe_deposit_intent_id:null, amount_charged:0, assembler_due:null, payout_status:null, refund_amount:0,
  service:'Furniture Assembly', date:'2026-09-29', time:'8:00 AM - 10:00 AM', address:'Fixture address',
};
const ready = {
  id:'new-easer', role:'assembler', full_name:'Replacement Easer', email:'replacement@example.test',
  phone:'5125550100', sms_consent_at:'2026-09-01', sms_opted_out_at:null,
  status:'active', application_status:'approved', tier:'starter', has_membership:false,
  identity_verified:true, is_owner:false, is_available:true, contractor_agreement_signed_at:'2026-09-01',
  contractor_agreement_version:CONTRACTOR_AGREEMENT_VERSION, code_of_conduct_agreed_at:'2026-09-01',
  application_fee_paid:false, application_fee_waived:true,
};
const snapshot = b => ({ assemblerId:b.assembler_id || null, assignedAt:b.assigned_at || null,
  status:b.status || null, acceptedAt:b.assembler_accepted_at || null, dispatchStatus:b.dispatch_status || null });
function apiHarness(options = {}) {
  const state = { booking:{ ...base, ...options.booking }, profile:{ ...ready, ...options.profile },
    writes:[], attempts:[], notifications:[], activities:[], counts:[], sequence:[], queries:[] };
  const db = { from(table) {
    return { filters:[], patch:null,
      select() { return this; }, eq(field,value) { this.filters.push([field,value]); return this; },
      is(field,value) { this.filters.push([field,value]); return this; },
      update(patch) { this.patch = patch; return this; }, single() { return this; }, maybeSingle() { return this; }, limit() { return this; },
      then(resolve,reject) {
        state.queries.push(table);
        let result;
        if (table === 'bookings' && this.patch) {
          state.attempts.push(plain(this.patch));
          if (options.racePatch) { Object.assign(state.booking, options.racePatch); options.racePatch = null; }
          const matches = this.filters.every(([field,value]) => (state.booking[field] ?? null) === value);
          if (options.writeError) result = { data:null,error:options.writeError };
          else if (!matches) result = { data:[],error:null };
          else { Object.assign(state.booking,this.patch); state.writes.push(plain(this.patch)); state.sequence.push('assignment'); result = { data:[{id:base.id,assembler_id:state.booking.assembler_id}],error:null }; }
        } else if (table === 'bookings') result = { data:options.missingBooking ? null : plain(state.booking),error:null };
        else if (table === 'profiles') result = { data:options.missingProfile ? null : plain(state.profile),error:options.profileError ? {message:'unavailable'} : null };
        else if (table === 'booking_crew') result = { data:options.crew || [],error:options.crewError ? {message:'unavailable'} : null };
        else if (table === 'dispatch_offers' && this.patch) { state.sequence.push('offer-cleanup'); result = {error:null}; }
        else throw new Error('Unexpected query ' + table);
        return Promise.resolve(result).then(resolve,reject);
      },
    };
  } };
  const context = vm.createContext({
    console:{error() {}}, crypto:{randomUUID:() => 'replacement-assignment-token'}, ...dates,
    getSupabase:() => db, verifyOwner:req => req.owner === true,
    BOOKING_STATUS, DISPATCH_OFFER_STATUS, describeDispatchPaymentBlock, computeBookingSplitFromSnapshot,
    getEaserReadiness:p => getEaserReadiness(p,{connectRequired:false}), readinessError,
    normalizeAssemblerTier, buildEaserFeeSnapshot, describeAssignmentGuardFailure, isOwnerManualLiveFlow,
    CONTACT_RELEASE_LEAD_HOURS:24, deriveOfferLocation:() => 'Austin, TX',
    esc:value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    ownerEmail:() => 'owner@example.test',
    adjustActiveJobs:async (sb,id,delta) => { state.counts.push({id,delta}); },
    logActivity:async (sb,row) => { state.activities.push(plain(row)); },
    sendEmail:async message => { state.notifications.push({channel:'email',message:plain(message)}); return {ok:true}; },
    sendSms:async message => { state.notifications.push({channel:'sms',message:plain(message)}); return {ok:true}; },
    sendPushToUser:async (id,message) => { state.notifications.push({channel:'push',id,message:plain(message)}); return {ok:true}; },
    offlineMethodFeeCents:() => { throw new Error('Ordinary reassignment must not calculate offline fees'); },
    verifyOwnerManualCustomerFundsForPayout:async () => ({ok:true}),
  });
  vm.runInContext(runnable,context,{filename:'api/booking/assign.js'});
  return { state, async call(overrides = {}) {
    const response = { status(code) { this.code=code; return this; }, json(body) { this.body=plain(body); return this; } };
    await context.handler({method:'POST',owner:true,body:{bookingId:base.id,assemblerId:ready.id,reassign:true,expectedAssignment:snapshot(state.booking)},...overrides},response);
    return response;
  } };
}
const protectedMoney = b => Object.fromEntries(['total_price','tax_amount','payment_status','stripe_payment_intent_id','stripe_deposit_intent_id','amount_charged','assembler_due','payout_status','refund_amount'].map(key => [key,b[key]]));
const accepted = apiHarness();
const oldSnapshot = snapshot(accepted.state.booking);
const moneyBefore = protectedMoney(accepted.state.booking);
assert.equal((await accepted.call()).code,200,'accepted confirmed work can be reassigned');
assert.equal(accepted.state.booking.assembler_id,ready.id);
assert.equal(accepted.state.booking.assembler_accepted_at,null,'replacement must accept independently');
assert.equal(accepted.state.booking.dispatch_status,'assigned_pending_acceptance');
assert.equal(accepted.state.booking.assignment_token,'replacement-assignment-token');
assert.deepEqual(protectedMoney(accepted.state.booking),moneyBefore,'no customer charge, refund, or payout fields change');
assert.deepEqual(accepted.state.counts,[{id:ready.id,delta:1},{id:base.assembler_id,delta:-1}]);
assert.deepEqual(accepted.state.sequence,['assignment','offer-cleanup']);
assert.equal(accepted.state.activities[0].eventType,'reassigned');
assert.equal(accepted.state.notifications.length,3,'existing replacement notifications are preserved');
assert.equal(accepted.state.notifications[0].message.to,ready.email);
const replay = await accepted.call({body:{bookingId:base.id,assemblerId:ready.id,reassign:true,expectedAssignment:oldSnapshot}});
assert.equal(replay.code,409); assert.equal(replay.body.code,'ASSIGNMENT_CHANGED');
assert.equal(accepted.state.writes.length,1); assert.equal(accepted.state.notifications.length,3);

async function refused(options,overrides,code,label) {
  const h = apiHarness(options); const result = await h.call(overrides);
  assert.equal(result.code,code,label); assert.equal(h.state.writes.length,0,label + ': no write');
  assert.equal(h.state.notifications.length,0,label + ': no sends');
  assert.equal(h.state.activities.length,0,label + ': no false activity');
  assert.equal(h.state.counts.length,0,label + ': no counter change');
  assert.ok(!h.state.sequence.includes('offer-cleanup'),label + ': no offer cleanup');
  return result;
}
await refused({}, {owner:false},401,'owner authentication');
await refused({}, {method:'GET'},405,'method');
await refused({}, {body:{bookingId:base.id,assemblerId:base.assembler_id,reassign:true}},409,'same Easer never clears acceptance');
await refused({}, {body:{bookingId:base.id,assemblerId:ready.id}},400,'explicit reassignment required');
for (const status of ['completed','cancelled','refunded','declined','pending']) await refused({booking:{status}},undefined,400,'closed or unconfirmed ' + status);
for (const field of ['financial_operation_key','financial_operation_type','financial_operation_started_at']) await refused({booking:{[field]:'busy'}},undefined,409,'financial operation ' + field);
for (const payment_status of ['pending','failed','not_required']) await refused({booking:{payment_status}},undefined,409,'payment ' + payment_status);
for (const profile of [{identity_verified:false},{is_available:false},{status:'suspended'},{application_fee_waived:false},{sms_consent_at:null},{contractor_agreement_version:'outdated'}]) await refused({profile},undefined,400,'canonical readiness ' + JSON.stringify(profile));
await refused({profileError:true},undefined,503,'profile lookup failed');
await refused({missingProfile:true},undefined,404,'missing replacement');
const crewRefusal = await refused({crew:[{id:'existing-pay-allocation'}]},undefined,409,'crew pay is not silently transferred');
assert.equal(crewRefusal.body.code,'CREW_HANDOFF_REQUIRES_REVIEW');
await refused({crewError:true},undefined,503,'unknown crew must fail closed');
const crewRace = await refused({writeError:{code:'23514',message:'Active crew allocations require review before changing the lead Easer'}},undefined,409,'crew added after API read');
assert.equal(crewRace.body.code,'CREW_HANDOFF_REQUIRES_REVIEW');
await refused({booking:{source:'owner_manual',payment_status:'offline_recorded'}},undefined,409,'offline exception remains owner-Easer only');
for (const expectedAssignment of [null,{},[],{...oldSnapshot,acceptedAt:42}]) await refused({}, {body:{bookingId:base.id,assemblerId:ready.id,reassign:true,expectedAssignment}},400,'malformed reviewed assignment');
for (const key of Object.keys(oldSnapshot)) {
  const result = await refused({}, {body:{bookingId:base.id,assemblerId:ready.id,reassign:true,expectedAssignment:{...oldSnapshot,[key]:'stale'}}},409,'stale review ' + key);
  assert.equal(result.body.code,'ASSIGNMENT_CHANGED');
}
for (const racePatch of [{status:'cancelled'},{assembler_id:'third-easer'},{assigned_at:'2026-09-28T12:00:00Z'},
  {assembler_accepted_at:'2026-09-28T12:00:00Z'},{dispatch_status:'released'},{payment_status:'refunded'},
  {stripe_payment_intent_id:'pi_other'},{total_price:99999},{financial_operation_key:'refund-lock'}]) {
  const result = await refused({racePatch},undefined,409,'concurrent change ' + JSON.stringify(racePatch));
  assert.equal(result.body.code,'ASSIGNMENT_CHANGED');
}
await refused({booking:{assembler_accepted_at:null,dispatch_status:'assigned_pending_acceptance'},racePatch:{assembler_accepted_at:'2026-09-28T12:00:00Z',dispatch_status:'accepted'}},undefined,409,'acceptance racing owner review');
const triggerResult = await refused({writeError:{code:'23514',message:'Assigned Easer is not ready and eligible for jobs'}},undefined,409,'database readiness guard');
assert.equal(triggerResult.body.code,'EASER_NOT_READY');
for (const status of ['en_route','arrived','in_progress']) {
  const h=apiHarness({booking:{status,en_route_at:'en-route',checked_in_at:'arrived',job_started_at:'started'}});
  assert.equal((await h.call()).code,200,status + ' emergency handoff stays available');
  assert.equal(h.state.booking.status,'confirmed');
  for (const field of ['en_route_at','checked_in_at','job_started_at','assembler_accepted_at']) assert.equal(h.state.booking[field],null);
  assert.deepEqual(protectedMoney(h.state.booking),moneyBefore);
}
const initial = apiHarness({booking:{assembler_id:null,assembler_name:null,assigned_at:null,assembler_accepted_at:null,dispatch_status:null}});
assert.equal((await initial.call({body:{bookingId:base.id,assemblerId:ready.id}})).code,200,'legacy initial assignment remains compatible');

// Run actual UI functions and click/change listeners; fake elements model option
// selection resets so the empty accepted-job dropdown cannot silently regress.
const ui = await readFile(new URL('../owner/index.html',import.meta.url),'utf8');
function namedFunction(name) {
  const start = ui.search(new RegExp('  (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0,name);
  const end = ui.indexOf('\n  }',start);
  return ui.slice(start,end+4);
}
const assignmentStart = ui.indexOf('  var eligibleAssemblers = []');
const assignmentEnd = ui.indexOf('\n  //',ui.indexOf('  function renderAssignSection',assignmentStart));
// The next top-level declaration marks the end; comments inside are indented more.
const assignmentFunctions = ui.slice(assignmentStart,assignmentEnd);
assert.ok(assignmentFunctions.includes('function renderAssignSection'));
const controlsStart = ui.indexOf('  window.toggleReassign = async function');
const controlsEnd = ui.indexOf('\n  //',controlsStart);
const controlsCode = ui.slice(controlsStart,controlsEnd);
function uiHarness(options = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      let html=''; let value='';
      elements.set(id,{style:{},dataset:{},disabled:false,textContent:'',listeners:{},
        get innerHTML() { return html; }, set innerHTML(v) {html=v; if (id==='assign-select') value='';},
        get value() {return value;},set value(v) { value=v; },
        addEventListener(event,callback) {this.listeners[event]=callback;},
      });
    }
    return elements.get(id);
  }
  const state={posts:[],confirms:[],toasts:[],refreshes:0,fetches:0};
  const context=vm.createContext({
    document:{getElementById:element},console:{error() {}},ownerSessionToken:null,
    allBookings:[{...base}],selectedId:base.id,crewState:{},renderCrewPanel() {},_evidenceCache:{},headers:() => ({}),
    esc:value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    fetch:async () => {state.fetches++; return options.fetch ? options.fetch() : {ok:true,json:async () => ({assemblers:[{id:base.assembler_id,full_name:'Previous Easer'},{...ready}],ownerEaser:null})};},
    confirm:message => {state.confirms.push(message);return options.confirm !== false;},
    apiPost:async (url,body) => {state.posts.push({url,body:plain(body)});return options.post ? options.post(url,body) : {ok:true,assignedTo:ready.full_name};},
    loadBookings:async () => {state.refreshes++;}, selectBooking() {},
    toast:(message,type) => {state.toasts.push({message,type});},
  });
  context.window=context;
  vm.runInContext(namedFunction('easerHasAccepted')+'\n'+assignmentFunctions+'\n'+controlsCode,context,{filename:'owner/index.html assignment controls'});
  return {context,state,element,render:() => context.renderAssignSection(context.allBookings.find(b => b.id===context.selectedId)),
    choose(value=ready.id) {const select=element('assign-select'); select.value=value;select.listeners.change.call(select);},
    click() {const button=element('assign-btn');return button.listeners.click.call(button);},
  };
}
const owner=uiHarness(); owner.render();
assert.match(owner.element('assign-status').innerHTML,/toggleReassign/);
assert.doesNotMatch(owner.element('assign-status').innerHTML,/releaseAssignment/,'accepted jobs cannot be released as unaccepted');
await owner.context.toggleReassign();
assert.equal(owner.state.fetches,1,'opening reassignment refreshes server eligibility');
assert.equal(owner.element('assign-controls').style.display,'flex');
assert.match(owner.element('assign-select').innerHTML,/new-easer/,'first direct visit to accepted job has replacements');
assert.doesNotMatch(owner.element('assign-select').innerHTML,/old-easer/,'current Easer is not a replacement');
owner.choose(); owner.render();
assert.equal(owner.element('assign-select').value,ready.id,'refresh preserves a reviewed choice for the same assignment');
assert.equal(owner.element('assign-controls').style.display,'flex');
await owner.click();
assert.equal(owner.state.posts.length,1); assert.equal(owner.state.confirms.length,1);
assert.match(owner.state.confirms[0],/Contact them about the handoff/);
assert.deepEqual(owner.state.posts[0].body,{bookingId:base.id,assemblerId:ready.id,expectedAssignment:oldSnapshot,reassign:true});
assert.equal(owner.state.refreshes,1);

const rejected=uiHarness({confirm:false});rejected.render();await rejected.context.toggleReassign();rejected.choose();await rejected.click();
assert.equal(rejected.state.posts.length,0,'cancel confirmation changes nothing');
const stale=uiHarness({post:async () => ({error:'The assignment changed',code:'ASSIGNMENT_CHANGED'})});
stale.render();await stale.context.toggleReassign();stale.choose();await stale.click();
assert.equal(stale.state.posts.length,1,'a stale response never automatically retries against a new assignee');
assert.equal(stale.state.refreshes,1);assert.equal(stale.context.assignmentEditor.open,false);

const switched=uiHarness();switched.render();await switched.context.toggleReassign();switched.choose();
switched.context.allBookings.push({...base,id:'unassigned-booking',assembler_id:null,assembler_accepted_at:null,assigned_at:null,dispatch_status:null});
switched.context.selectedId='unassigned-booking';switched.render();
assert.equal(switched.context.assignmentEditor.open,false);assert.equal(switched.element('assign-select').value,'');
switched.choose();await switched.click();
assert.equal(switched.state.posts[0].body.bookingId,'unassigned-booking');
assert.equal(switched.state.posts[0].body.reassign,undefined,'reassign mode cannot leak to another booking');
assert.equal(switched.state.confirms.length,0);

for (const [fetch,copy] of [
  [async () => ({ok:true,json:async () => ({assemblers:[{id:base.assembler_id,full_name:'Previous Easer'}]})}),/No other eligible/],
  [async () => ({ok:false}),/could not be verified/],
]) {
  const h=uiHarness({fetch});h.render();await h.context.toggleReassign();
  assert.equal(h.element('assign-btn').disabled,true);assert.match(h.element('assign-choice-status').textContent,copy);
  await h.click();assert.equal(h.state.posts.length,0);
}
let finishPost;
const pendingPost = new Promise(resolve => {finishPost=resolve;});
const double=uiHarness({post:() => pendingPost});double.render();await double.context.toggleReassign();double.choose();
const firstClick=double.click();await double.click();
assert.equal(double.state.posts.length,1,'double click sends one assignment request');
double.render();assert.equal(double.element('assign-btn').disabled,true,'refresh cannot enable an in-flight assignment');
finishPost({ok:true});await firstClick;

const advanced=uiHarness();advanced.render();await advanced.context.toggleReassign();advanced.choose();
advanced.context.allBookings[0].status='in_progress';
await advanced.click();assert.equal(advanced.state.posts.length,0,'local lifecycle change requires a fresh handoff review');
assert.equal(advanced.context.assignmentEditor.open,false);
await advanced.context.toggleReassign();advanced.choose();await advanced.click();
assert.match(advanced.state.confirms[0],/partial pay/,'active work explains separate old-Easer compensation');
advanced.context.allBookings[0].status='completed';advanced.render();
assert.equal(advanced.element('assign-section').style.display,'none','completed online work is not reopened');

let resolveOlder;
let lookup=0;
const raced=uiHarness({fetch:async () => ++lookup===1
  ? new Promise(resolve => {resolveOlder=resolve;})
  : {ok:false}});
const older=raced.context.loadAssemblers();await raced.context.loadAssemblers();
resolveOlder({ok:true,json:async () => ({assemblers:[ready]})});await older;
assert.equal(raced.context.assemblerChoicesAvailable,false,'late lookup cannot replace the newer failure with stale eligibility');
console.log('owner accepted reassignment behavioral tests: PASS');
