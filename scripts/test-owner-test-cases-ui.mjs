// Execute the shipped Cases controller with a minimal DOM and stubbed GETs.
// No production data, network requests, case closures, or outbound messages.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../owner/assets/cases.js',import.meta.url),'utf8');
const css=await readFile(new URL('../owner/assets/cases.css',import.meta.url),'utf8');
const keepIds=['cases-list','cases-detail','cases-list-count','cases-stat-active','cases-stat-new','cases-stat-priority','cases-stat-waiting','nav-cases'];
function harness(responses){
  const elements=new Map();
  const calls=[];
  function element(id){
    if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',style:{},listeners:{},addEventListener(event,handler){this.listeners[event]=handler;}});
    return elements.get(id);
  }
  for(const id of keepIds){element(id).innerHTML='Existing '+id;element(id).textContent='21';}
  const before=keepIds.map(id=>({id,html:element(id).innerHTML,text:element(id).textContent,style:{...element(id).style}}));
  const context={window:{_ownerHeaders:()=>({'X-Owner-Token':'fixture-only'})},document:{getElementById:element,addEventListener(){}},URLSearchParams,
    fetch:async(url,options)=>{
      calls.push({url,options});
      assert.equal(url,'/api/owner/test-cases','utility calls only the read-only search endpoint');
      assert.equal(options.method,undefined,'search must never POST or close a case');
      assert.equal(options.headers['X-Owner-Token'],'fixture-only');
      const response=responses.shift();assert.ok(response,'unexpected request');
      return typeof response==='function'?response():response;
    },
  };
  vm.runInNewContext(source,context,{filename:'owner/assets/cases.js'});
  return {element,calls,search:()=>context.window.OwnerCases.findTestCases(),
    retry:()=>element('cases-sweep-retry').listeners.click(),
    assertPrimaryUnchanged(){assert.deepEqual(keepIds.map(id=>({id,html:element(id).innerHTML,text:element(id).textContent,style:{...element(id).style}})),before);},
  };
}
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const h=harness([
  response({error:'Cases could not be read. <private>'},503),
  response({activeCount:21,suspects:[]}),
]);
await h.search();
let markup=h.element('cases-test-sweep').innerHTML;
assert.match(markup,/role="alert"/,'error is announced');
assert.match(markup,/Test-case search failed\./,'failure identifies the utility, not the main case list');
assert.match(markup,/Cases could not be read\. &lt;private&gt;/,'server error is escaped and retained');
assert.match(markup,/Retry search/);
assert.doesNotMatch(markup,/class="cases-error"|class="cases-loading"/,'utility never inherits primary-panel 220px styles');
h.assertPrimaryUnchanged();
await h.retry();
markup=h.element('cases-test-sweep').innerHTML;
assert.match(markup,/No suspected test cases found among 21 active cases\./);
assert.doesNotMatch(markup,/look real|all.*real|role="alert"/i);
assert.match(markup,/role="status"/);
assert.equal(h.calls.length,2);h.assertPrimaryUnchanged();

let finish;
const pending=new Promise(resolve=>{finish=resolve;});
const busy=harness([()=>pending,response({activeCount:0,suspects:[]})]);
const initial=busy.search();
assert.match(busy.element('cases-test-sweep').innerHTML,/Looking for cases left over from testing/);
assert.match(busy.element('cases-test-sweep').innerHTML,/role="status"/);
await busy.search();await busy.search();
assert.equal(busy.calls.length,1,'repeat clicks cannot race multiple searches');
busy.assertPrimaryUnchanged();
finish(response({activeCount:1,suspects:[{id:'case-fixture',status:'open',ref:'CASE-FIXTURE',subject:'Test record',signals:["text says 'test'"],bookingRef:null}],caveat:'Suspected, not confirmed.'}));
await initial;
assert.match(busy.element('cases-test-sweep').innerHTML,/checked data-sweep-id="case-fixture"/,'existing closure selection behavior is preserved');
assert.match(busy.element('cases-test-sweep').innerHTML,/Close the ticked cases/);
assert.equal(typeof busy.element('cases-sweep-close').listeners.click,'function','existing audited closure handler is still attached');
busy.assertPrimaryUnchanged();
await busy.search();
assert.equal(busy.calls.length,2,'a finished search releases the in-flight guard');
assert.match(busy.element('cases-test-sweep').innerHTML,/No suspected test cases found among 0 active cases\./);
busy.assertPrimaryUnchanged();

const network=harness([async()=>{throw new Error('Network unavailable');},response({activeCount:1,suspects:[]})]);
await network.search();assert.match(network.element('cases-test-sweep').innerHTML,/Network unavailable/);
await network.retry();assert.equal(network.calls.length,2,'failed request also releases the in-flight guard');
network.assertPrimaryUnchanged();
const compactRule=css.match(/\.cases-sweep-feedback\s*\{([^}]+)\}/)?.[1];
assert.ok(compactRule,'utility has its own layout');
assert.doesNotMatch(compactRule,/min-height|height:\s*220px/,'utility layout does not reserve a full panel');
assert.match(compactRule,/flex-wrap:\s*wrap/,'retry can wrap on narrow screens');
console.log('owner test-case search UI behavioral tests: PASS');
