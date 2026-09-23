// Run the actual owner loader, renderers and mutation refresh helper with no network.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const dashboard = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
function fn(name) {
  const match = new RegExp(`  (?:async )?function ${name}\\(`).exec(dashboard);
  assert.ok(match, `${name} exists`);
  const end = dashboard.indexOf('\n  }', match.index) + '\n  }'.length;
  return dashboard.slice(match.index, end);
}
const rendererNames = ['renderMarketDemand','mdCountRows','mdSupplyCount','mdDemandCount','renderMarketSummaryLinks','renderMarketRows','renderMarketRequests','mdMiniMetric','mdStatusPill'];
const lifecycle = dashboard.slice(dashboard.indexOf('  var _marketDemandTimer ='), dashboard.indexOf('  function mdSetLoading()'));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const profile = { id:'00000000-0000-4000-8000-000000000001', recordType:'easer', name:'Fixture Easer', status:'active',
  applicationStatus:'approved', city:'Round Rock', state:'TX', zip:'78664', marketLabel:'Austin / Central Texas',
  isAvailable:false, eligible:true, missingItems:[], locationIssue:null };
const blocked = { ...profile, id:'00000000-0000-4000-8000-000000000002', name:'Fixture Held Easer', eligible:false,
  city:'Different recorded city', missingItems:['Current contractor agreement'], locationIssue:'Recorded city differs from ZIP area' };
const waitlist = { id:'waitlist-fixture', recordType:'waitlist', name:'Fixture Waiting Applicant', status:'pending', city:'Austin', zip:'',
  marketLabel:'Location review', locationIssue:'ZIP is missing' };
function market(index) {
  const rows = index === 0 ? [profile,blocked] : [];
  return { marketKey:'fixture-'+index, marketLabel:index === 0 ? 'Austin / Central Texas' : 'Fixture area '+index,
    isActiveMarket:true, coverageKnown:true, activationStatus:index === 0 ? 'LIMITED COVERAGE' : 'COVERAGE NEEDED',
    approvedEasers:rows.length, readyEasers:index === 0 ? 1 : 0, waitlistEasers:0, topServices:[], requestedZips:[],
    demandRows:[], bookedRows:[], unbookedRows:[], supplyRows:{all:rows,approved:rows,ready:index === 0 ? [profile] : [],online:[],pending:[],waitlist:[],reviewRecords:index === 0 ? [blocked] : []} };
}
function snapshot(overrides = {}) {
  const markets = Array.from({length:15}, (_, i) => market(i));
  return { generatedAt:'2026-09-23T15:00:00Z', supplyAvailable:true, waitlistAvailable:true,
    sourceStatus:{easers:'available',waitlist:'available',bookings:'available',requests:'available'},
    summary:{readyEasers:1,easerSupplyByMarket:2,ownerActionRequired:2}, markets, topMarkets:markets.slice(0,12), requests:[],
    summaryRows:{ready:[profile],approved:[profile,blocked],allEasers:[profile,blocked],reviewRecords:[blocked,waitlist],waitlist:[waitlist]}, ...overrides };
}

function harness() {
  const elements = new Map(), requests = [], intervals = new Map(), listeners = {}, calls = [];
  let nextInterval = 0;
  function element() {
    return {innerHTML:'',textContent:'',style:{},children:[],classList:{remove() {},add() {},toggle() {}},
      querySelector(selector) { return selector === '.md-summary-rows' ? this.children.find(child=>child.className==='md-summary-rows') : null; },
      appendChild(child) { child.parentNode=this; this.children.push(child); },
      remove() { this.parentNode.children=this.parentNode.children.filter(child=>child!==this); },
      insertAdjacentHTML(position,html) { this.innerHTML=position==='afterbegin' ? html+this.innerHTML : this.innerHTML+html; },
    };
  }
  function get(id) { if (!elements.has(id)) { const item=element(); item.parentNode=element(); elements.set(id,item); } return elements.get(id); }
  const document = {hidden:false,getElementById:get,createElement:element,querySelectorAll:()=>[],
    addEventListener:(name,callback)=>{listeners['document:'+name]=callback;} };
  const window = {addEventListener:(name,callback)=>{listeners['window:'+name]=callback;}};
  const context = vm.createContext({document,window,console,esc,headers:()=>({}),currentView:'market-demand',ownerSessionToken:'fixture-only',
    fmt$:value=>'$'+(value/100).toFixed(2),
    fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),
    setInterval:(callback,ms)=>{const id=++nextInterval; intervals.set(id,{callback,ms}); return id;},clearInterval:id=>intervals.delete(id),
    loadAssemblerList:async()=>{calls.push('roster'); return true;},loadAssemblers:async()=>{calls.push('assignment');},
    allAssemblerProfiles:[],toast:message=>calls.push(message),currentAssemblerDetailId:null,
  });
  vm.runInContext([lifecycle,fn('mdSetLoading'),...rendererNames.map(fn),fn('reloadAssemblersAndMaybeRefreshDetail')].join('\n'),context);
  function respond(index,data,ok=true) { requests[index].resolve({ok,json:async()=>data}); }
  return {context,elements,requests,intervals,listeners,calls,get,respond};
}
const flush = () => new Promise(resolve=>setImmediate(resolve));

// Latest-request wins, including a slower previous request's failure.
const race=harness();
const old=race.context.loadMarketDemand(), fresh=race.context.loadMarketDemand();
race.respond(1,snapshot({markets:[{...market(0),marketLabel:'New snapshot area'}]})); await fresh;
race.respond(0,snapshot({markets:[{...market(0),marketLabel:'Old snapshot area'}]})); await old;
assert.match(race.get('md-top-markets').innerHTML,/New snapshot area/);
assert.doesNotMatch(race.get('md-top-markets').innerHTML,/Old snapshot area/);
assert.equal(race.requests[0].options.cache,'no-store');
const losing=race.context.loadMarketDemand(), winning=race.context.loadMarketDemand();
race.respond(3,snapshot()); await winning;
race.requests[2].reject(new Error('Older request failed')); await losing;
assert.match(race.get('md-snapshot-status').textContent,/snapshot loaded/);
assert.equal(race.get('nav-market-demand').textContent,2);

// Full list, exact drilldowns, detailed blockers, and cross-source review records.
const html=race.get('md-top-markets').innerHTML;
assert.match(html,/Fixture area 14/,'The 13th-15th areas must not disappear behind topMarkets');
assert.match(html,/Eligible Easers: 1/);
assert.match(html,/Availability on: 0/);
assert.match(html,/Recorded location: Round Rock, TX, 78664/);
assert.match(html,/Needs: Current contractor agreement/);
assert.match(html,/Availability switched off/);
assert.match(race.get('md-reconciliation').innerHTML,/All Easer profiles: 2/);
assert.match(race.get('md-reconciliation').innerHTML,/Fixture Waiting Applicant/);
assert.doesNotMatch(race.get('md-reconciliation').innerHTML,/data-demand-easer="waitlist-fixture"/);
assert.doesNotMatch(race.context.mdSupplyCount('Test',[{...profile,name:'<script>bad</script>',missingItems:['<img src=x>']}]),/<script>|<img src=x>/);

// Refresh retains an entire previous snapshot, not new totals with old detail lists.
const beforeHtml=race.get('md-top-markets').innerHTML;
const beforeDetails=race.get('md-supply').parentNode.querySelector('.md-summary-rows');
const failed=race.context.loadMarketDemand();
assert.equal(race.get('md-supply').textContent,1);
assert.equal(race.get('md-supply').parentNode.querySelector('.md-summary-rows'),beforeDetails);
race.requests[4].reject(new Error('Offline')); await failed;
assert.equal(race.get('md-top-markets').innerHTML,beforeHtml);
assert.equal(race.get('md-supply').parentNode.querySelector('.md-summary-rows'),beforeDetails);
assert.match(race.get('md-snapshot-status').textContent,/previous snapshot; current counts are unverified/);
assert.match(race.get('md-snapshot-status').textContent,/Sep|9\/23\/2026/);
assert.equal(race.get('nav-market-demand').textContent,'!');
const initialFailure=harness();
const previous=initialFailure.get('md-supply').parentNode;
const stale={className:'md-summary-rows',remove(){previous.children=[];}}; previous.children.push(stale);
const unavailable=initialFailure.context.loadMarketDemand();
initialFailure.requests[0].reject(new Error('Unavailable')); await unavailable;
assert.equal(initialFailure.get('md-supply').textContent,'—');
assert.equal(previous.children.length,0);
assert.match(initialFailure.get('md-top-markets').innerHTML,/not a count of zero/);

// Independent failure truth: profile failure is Unknown, waitlist failure doesn't erase known profiles.
const partial=harness();
partial.context.renderMarketDemand(snapshot({supplyAvailable:false,markets:[market(0)]}));
assert.equal(partial.get('md-supply').textContent,'Unknown');
assert.match(partial.get('md-top-markets').innerHTML,/Eligible Easers: Unknown/);
assert.match(partial.get('md-top-markets').innerHTML,/SUPPLY UNAVAILABLE/);
assert.doesNotMatch(partial.get('md-top-markets').innerHTML,/Eligible Easers: 0/);
partial.context.renderMarketDemand(snapshot({waitlistAvailable:false,markets:[market(0)]}));
assert.equal(partial.get('md-supply').textContent,1);
assert.match(partial.get('md-top-markets').innerHTML,/Waitlist: Unknown/);
assert.match(partial.get('md-top-markets').innerHTML,/Location records to review: Unknown/);
assert.match(partial.get('md-reconciliation').innerHTML,/Location records to review: Unknown/);
partial.context.renderMarketDemand(snapshot({sourceStatus:{requests:'unavailable'},markets:[market(0)]}));
assert.equal(partial.get('md-active').textContent,'Unknown');
assert.equal(partial.get('md-requests').textContent,'Unknown');
assert.equal(partial.get('md-potential').textContent,'Unknown');
assert.equal(partial.get('md-emerging').textContent,0);
assert.match(partial.get('md-top-markets').innerHTML,/All Demand: Unknown/);
assert.match(partial.get('md-top-markets').innerHTML,/Configured ZIP service area/);

// Poll only while visible/authenticated, refresh on focus/visibility, stop the timer on leaving.
const polling=harness();
polling.context.startMarketDemand();
assert.equal(polling.requests.length,1);
const timer=[...polling.intervals.values()][0]; assert.equal(timer.ms,30000);
polling.context.document.hidden=true; timer.callback(); assert.equal(polling.requests.length,1);
polling.context.document.hidden=false; polling.listeners['document:visibilitychange'](); assert.equal(polling.requests.length,2);
polling.listeners['window:focus'](); assert.equal(polling.requests.length,3);
timer.callback(); assert.equal(polling.requests.length,4);
polling.context.currentView='assemblers'; timer.callback(); polling.listeners['window:focus'](); assert.equal(polling.requests.length,4);
polling.context.currentView='market-demand'; polling.context.ownerSessionToken=''; timer.callback(); assert.equal(polling.requests.length,4);
polling.context.stopMarketDemand(); assert.equal(polling.intervals.size,0);

// Actual post-mutation reload helper invalidates older reads and fetches the visible market.
const changed=harness();
const beforeChange=changed.context.loadMarketDemand();
const reloaded=changed.context.reloadAssemblersAndMaybeRefreshDetail(profile.id,false);
assert.deepEqual(changed.calls,['roster','assignment']); assert.equal(changed.requests.length,2);
changed.respond(1,snapshot({markets:[{...market(0),marketLabel:'After Easer change'}]})); await reloaded;
changed.respond(0,snapshot({markets:[{...market(0),marketLabel:'Before Easer change'}]})); await beforeChange;
assert.match(changed.get('md-top-markets').innerHTML,/After Easer change/);
changed.context.currentView='assemblers';
await changed.context.reloadAssemblersAndMaybeRefreshDetail(profile.id,false);
assert.equal(changed.requests.length,2,'Hidden market waits for next visit rather than fetching in the background');
assert.match(changed.get('md-snapshot-status').textContent,/needs refreshing/);

// Actual modal action reaches the same refresh only after successful server mutation.
const action=harness(); action.context.window.confirm=()=>true;
const actionStart=dashboard.indexOf('  window.asmAction = async function(');
vm.runInContext(dashboard.slice(actionStart,dashboard.indexOf('\n  };',actionStart)+6),action.context);
const rejected=action.context.window.asmAction(profile.id,'mark_id_verified');
action.respond(0,{error:'Not permitted'},false); await rejected;
assert.equal(action.calls.includes('roster'),false); assert.equal(action.requests.length,1);
const successful=action.context.window.asmAction(profile.id,'mark_id_verified');
action.respond(1,{ok:true}); await flush();
assert.deepEqual(action.calls.slice(-2),['roster','assignment']);
assert.equal(action.requests[2].url,'/api/owner/market-demand');
action.respond(2,snapshot()); await successful;

for (const script of dashboard.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (script[1].trim()) new vm.Script(script[1]);
if (process.argv.includes('--fixture')) {
  const style=[...dashboard.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match=>match[1]).join('\n');
  const start=dashboard.indexOf('<div id="market-demand-view"');
  const end=dashboard.lastIndexOf('<!--',dashboard.indexOf('WAITLIST VIEW',start));
  const markup=dashboard.slice(start,end).replace('id="market-demand-view" style="display:none"','id="market-demand-view"');
  const fixtureData=snapshot({markets:[market(0),{...market(1),marketLabel:'San Antonio'},{...market(2),marketLabel:'Location review',activationStatus:'LOCATION REVIEW',coverageKnown:false,locationIssue:'ZIP is missing',supplyRows:{all:[],approved:[],ready:[],online:[],pending:[],waitlist:[waitlist],reviewRecords:[waitlist]}}]});
  const script=`var esc=${esc.toString()};var fmt$=value=>'$'+(value/100).toFixed(2);${rendererNames.map(fn).join('\n')}renderMarketDemand(${JSON.stringify(fixtureData)});document.getElementById('md-snapshot-status').textContent='Fixture snapshot: September 23, 2026, 10:00 AM CDT. No live requests.';`;
  await mkdir(new URL('../tmp/',import.meta.url),{recursive:true});
  await writeFile(new URL('../tmp/market-demand-refresh-fixture.html',import.meta.url),`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head><body><main style="padding:20px;max-width:1400px;margin:auto">${markup}</main><script>${script}</script></body></html>`);
}
console.log('Market demand frontend: PASS (latest response, mutation refresh, visible polling, failure snapshots, source availability, complete areas, detailed records)');
