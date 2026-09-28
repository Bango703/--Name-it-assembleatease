// Exercise the actual route authorization/query blocks with an in-memory query
// adapter. This tests role filters and outcomes, not just source spelling.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {easerIsOnBooking,crewRoleFor} from '../api/booking/_crew.js';
const read=file=>readFile(new URL('../'+file,import.meta.url),'utf8');
const booking={id:'fixture-booking',assembler_id:'new-lead',assembler_name:'Current Easer',assembler_accepted_at:'2026-09-28T12:00:00Z',status:'confirmed'};
const crew=[
  {booking_id:booking.id,easer_id:'old-lead',id:'old',role:'lead',removed_at:null,due_cents:12345,payout_status:'owed'},
  {booking_id:booking.id,easer_id:'helper',id:'helper',role:'helper',removed_at:null},
  {booking_id:booking.id,easer_id:'removed-helper',id:'removed',role:'helper',removed_at:'2026-09-27'},
];
for(const [id,allowed,role] of [['new-lead',true,'lead'],['helper',true,'helper'],['old-lead',false,null],['removed-helper',false,null],['stranger',false,null]]){
  assert.equal(easerIsOnBooking(booking,crew,id),allowed,'canonical access '+id);
  assert.equal(crewRoleFor(booking,crew,id),role,'canonical role '+id);
}
assert.equal(easerIsOnBooking(booking,[],booking.assembler_id),true,'current lead remains authoritative without crew rows');
const source={
  message:await read('api/booking/message.js'),
  evidence:await read('api/booking/upload-evidence.js'),
  status:await read('api/booking/easer-status.js'),
  list:await read('api/booking/my-assignments.js'),
};
function section(text,from,to){const start=text.indexOf(from);assert.ok(start>=0,from);const end=text.indexOf(to,start);assert.ok(end>start,to);return text.slice(start,end);}
const guards={
  message:section(source.message,'    if (!ownerRequest && (bk.assembler_id', '    let messagesQuery'),
  evidence:section(source.evidence,'  if (booking.assembler_id !== user.id) {','  // Complete every assignment'),
  status:section(source.status,'  if (booking.assembler_id !== user.id) {','  if (!booking.assembler_accepted_at)'),
};
const listQuery=section(source.list,'  let crewBookingIds = [];','  if (error) {');
function database(){
  return {from(table){
    const query={filters:[],one:false,orFilter:null,
      select(){return this;},eq(key,value){this.filters.push(row=>row[key]===value);return this;},
      is(key,value){this.filters.push(row=>(row[key]??null)===value);return this;},
      in(key,values){this.filters.push(row=>values.includes(row[key]));return this;},
      maybeSingle(){this.one=true;return this;},order(){return this;},
      or(value){this.orFilter=value;return this;},
      then(resolve,reject){
        let rows=(table==='booking_crew'?crew:[booking]).filter(row=>this.filters.every(test=>test(row)));
        if(this.orFilter){
          const match=this.orFilter.match(/^assembler_id\.eq\.([^,]+),id\.in\.\(([^)]*)\)$/);
          assert.ok(match,'expected actual owner-or-helper list query');
          rows=rows.filter(row=>row.assembler_id===match[1]||match[2].split(',').includes(row.id));
        }
        return Promise.resolve({data:this.one?(rows[0]||null):rows,error:null}).then(resolve,reject);
      },
    };return query;
  }};
}
async function run(code,id){
  const context=vm.createContext({sb:database(),booking,bk:booking,user:{id},easerAccess:{user:{id}},ownerRequest:false,
    console:{error(){}},statusFilter:null,VISIBLE_STATUSES:['confirmed'],
    res:{status(code){this.code=code;return this;},json(body){return {code:this.code,body};}},
  });
  return await vm.runInContext('(async function(){'+code+'\n})()',context);
}
for(const id of ['new-lead','old-lead','helper','removed-helper','stranger']){
  for(const path of ['message','evidence']){
    const result=await run(guards[path]+'\nreturn {code:200};',id);
    assert.equal(result.code,['new-lead','helper'].includes(id)?200:404,`${path} actual guard ${id}`);
  }
  const status=await run(guards.status+'\nreturn {code:200};',id);
  assert.equal(status.code,id==='new-lead'?200:403,'job status stays with current lead '+id);
  if(id==='helper')assert.equal(status.body.code,'CREW_NOT_LEAD');
  if(['old-lead','removed-helper','stranger'].includes(id))assert.equal(status.body.code,'NOT_ASSIGNED');
  const jobs=await run(listQuery+'\nreturn assignedBookings;',id);
  assert.equal(jobs.length,['new-lead','helper'].includes(id)?1:0,'actual assignment list query '+id);
}
// A stale lead row cannot bypass the current lead's acceptance requirement for
// message access, either. A current accepted lead still takes the direct path.
booking.assembler_id='old-lead';booking.assembler_accepted_at=null;
assert.equal((await run(guards.message+'\nreturn {code:200};','old-lead')).code,404);
console.log('crew handoff access boundary behavioral tests: PASS');
