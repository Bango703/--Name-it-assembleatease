import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Fictional display-only fixtures. No credentials, real records or network.
const customerLines = [
  'Sora Customer request. Caller identity and any job reference are NOT verified.',
  'Caller: TEST - Jordan Example', 'Callback: +15125550100', 'Email: Not provided', 'City: Austin',
  'Topic: New service request', 'Active job reported: Not reported', 'Job reference (unverified): Not provided',
  'Summary: Assemble a queen bed and a treadmill in an upstairs room. Both products have arrived in their original boxes.',
  'Requested outcome: Confirm the scope and available dates before booking.',
  'Preferred callback time (not promised): Monday afternoon, if possible',
  'Services: Furniture Assembly; Fitness Equipment', 'Service address: 123 Fictional Example Lane, Unit B', 'ZIP code: 78701',
  'Preferred service date (not confirmed): Next Friday, date to confirm', 'Preferred service window (not confirmed): Morning preferred',
  'Readiness (caller report): ready', 'Product / project notes: New boxed products; hardware supplied. Queen bed and folding treadmill.',
  'Site notes (no access codes): Second floor with stairs. Parking available in the driveway.',
  'Items are caller descriptions, NOT priced or verified catalog selections:',
  '- 1 x Queen bed [Furniture Assembly]', '- 1 x Treadmill [Fitness Equipment]',
  'Still to clarify: email (optional)',
  'Caller confirmed these details and permitted a callback. No SMS or marketing consent inferred.',
  'REQUEST ONLY: no booking confirmed, payment taken, account accessed, dispatch sent, cancellation/refund processed, or payout changed.',
  'Owner: verify identity/assignment before disclosing private information or changing an existing job. Emergency reports require human follow-up; this case is not emergency dispatch.',
];
const base = { id:'fictional-layout-case',ref:'AAE-AI-LAYOUT-TEST',subject:'Sora Customer: New service request',type:'support',typeLabel:'Support Request',
  severity:'normal',status:'open',statusLabel:'Open',source:'system',customerStatus:{label:'Received'},
  customer:{name:'TEST - Jordan Example',phone:'+15125550100'},easer:null,booking:null,
  notifications:{attempts:1,failed:0,latest:{status:'delivered'}},updatedAt:'2026-09-06T21:51:00Z',
  availableActions:[{action:'acknowledge',label:'Acknowledge',requiresConfirmation:false},{action:'close',label:'Close',requiresConfirmation:true}],
};
export const fixtures = {
  customer: {...base,description:customerLines.join('\n')},
  pro: {...base,subject:'Sora Service Pro: Earnings, payout or payment question',type:'payment',typeLabel:'Payment Issue',severity:'high',customer:null,
    description:[
      'Sora Easer / Service Pro request. Caller identity and any job reference are NOT verified.',
      'Caller: TEST - Casey Example','Callback: +15125550101','Email: Not provided','City: San Antonio',
      'Topic: Earnings, payout or payment question','Active job reported: Yes (caller report)',
      'Job reference (unverified): TEST-JOB-ONLY','Summary: Easer needs help understanding earnings and reports missing parts at the current job. Work is paused.',
      'Requested outcome: Confirm how to proceed and review the earnings question.','Preferred callback time (not promised): As available',
      ...customerLines.slice(-4),
    ].join('\n')},
  legacy: {...base,subject:'Customer follow-up',description:'Please follow up about the appointment.\nThe product delivery has been delayed.\n\nThe customer prefers a call tomorrow afternoon.'},
};
export const fixtureEvents = [
  {type:'created',actor:{name:'Sora (unverified intake)'},createdAt:base.updatedAt,note:'Request details saved for follow-up.',publicMessage:'We received your request.'},
  {type:'notification_attempted',actor:{name:'Notifications'},createdAt:base.updatedAt,note:'Owner alert accepted by the email provider; delivery was not yet confirmed at this event.\nThe current notification summary shows Delivered.'},
];

export async function renderFixture(item, events = fixtureEvents) {
  const elements = { 'cases-detail':{innerHTML:''} };
  const calls = [];
  const context = {
    window:{},document:{getElementById:id=>elements[id]||null,addEventListener(){}},URLSearchParams,
    fetch:async (url, options) => {
      assert.equal(options.method, undefined, 'Rendering must remain read-only');
      assert.equal(url, '/api/owner/cases?caseId=' + encodeURIComponent(item.id));
      calls.push(url); return {ok:true,json:async()=>({case:item,events})};
    },
  };
  vm.runInNewContext(await readFile(new URL('../owner/assets/cases.js',import.meta.url),'utf8'),context);
  await context.window.OwnerCases.select(item.id);
  assert.equal(calls.length,1);
  return elements['cases-detail'].innerHTML;
}
const escape = value => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

export async function testLayout() {
  const original = structuredClone(fixtures);
  for (const [role, item] of Object.entries(fixtures)) {
    const html = await renderFixture(item);
    assert.match(html,/cases-description/);
    assert.match(html,/cases-update-form/);
    assert.match(html,/cases-timeline/);
    assert.match(html,/data-confirm="true"/);
    assert.match(html,/This does not send money/);
    const formatted = html.split('<details class="cases-original-request">')[0];
    for (const line of item.description.split('\n').filter(Boolean)) {
      const separator = line.indexOf(':');
      const text = line.startsWith('- ') ? line.slice(2) : separator > 0 ? line.slice(separator+1).trim() : line;
      if (text) assert.ok(formatted.includes(escape(text)), role + ': retained ' + text);
    }
    if (role !== 'legacy') {
      assert.match(html,/<h4>Request summary<\/h4>/);
      assert.match(html,/<h4>Caller &amp; callback<\/h4>/);
      assert.ok(html.includes('<div class="cases-original-text">' + escape(item.description) + '</div>'));
      assert.match(html,/Follow-up &amp; verification/);
    }
    if (role === 'customer') {
      assert.match(html,/<li>1 x Queen bed \[Furniture Assembly\]<\/li>/);
      assert.match(html,/<li>1 x Treadmill \[Fitness Equipment\]<\/li>/);
      assert.match(html,/Preferred service date \(not confirmed\)/);
    }
    if (role === 'pro') {
      assert.doesNotMatch(html,/<h4>Service &amp; location<\/h4>|<h4>Items requested<\/h4>/);
      assert.match(html,/<dd>Yes \(caller report\)<\/dd>/);
    }
  }
  assert.deepEqual(fixtures,original,'Rendering never mutates source data');
  for (const description of [null,'','<script>alert("not code")</script>\n<img src=x onerror=alert(1)>',
    fixtures.customer.description + '\nNew future field: Retain this fact\nSummary: Keep repeated labels too\n<img src=x onerror=alert(1)>',
    fixtures.customer.description.replaceAll('\n','\r\n'),
    fixtures.customer.description.replace('Queen bed','x'.repeat(700)),
  ]) {
    const html = await renderFixture({...base,description});
    assert.doesNotMatch(html,/<script>|<img\s/i);
    if (description?.includes('New future field')) {
      const formatted = html.split('<details class="cases-original-request">')[0];
      assert.match(formatted,/New future field: Retain this fact/);
      assert.match(formatted,/<dd>Keep repeated labels too<\/dd>/);
    }
  }
  const css=await readFile(new URL('../owner/assets/cases.css',import.meta.url),'utf8');
  assert.match(css,/\.cases-request-field dd[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css,/\.cases-original-text[\s\S]*?white-space: pre-wrap/);
  assert.match(css,/@media \(max-width: 520px\)/);
  console.log('PASS: Case detail layout — customer, Easer, legacy, full text retention, missing/duplicate/unknown fields, XSS escaping, read-only rendering and existing controls.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await testLayout();
