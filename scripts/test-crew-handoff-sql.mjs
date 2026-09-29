// Actual migration executed in isolated PostgreSQL; no live database access.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const modulePath=process.argv[2];
if(!modulePath)throw new Error('Pass the local @electric-sql/pglite/dist/index.js path.');
const {PGlite}=await import(pathToFileURL(modulePath).href);
const db=new PGlite();
const oldLead='10000000-0000-4000-8000-000000000001';
const nextLead='10000000-0000-4000-8000-000000000002';
const bookingId='20000000-0000-4000-8000-000000000001';
await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE TABLE public.bookings(id uuid PRIMARY KEY,assembler_id uuid,status text,total_price integer,payment_status text);
CREATE TABLE public.booking_crew(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),booking_id uuid,easer_id uuid,role text,removed_at timestamptz,due_cents integer,payout_status text);
CREATE TABLE public.platform_schema_state(migration_number integer PRIMARY KEY,migration_name text);
ALTER TABLE public.booking_crew ENABLE ROW LEVEL SECURITY;
INSERT INTO public.bookings VALUES('${bookingId}','${oldLead}','confirmed',21650,'authorized');`);
const migration=await readFile(new URL('../api/migrations/101_guard_crew_assignment_handoff.sql',import.meta.url),'utf8');
await db.exec(migration);await db.exec(migration);
const changeLead=lead=>db.query('UPDATE public.bookings SET assembler_id=$1 WHERE id=$2',[lead,bookingId]);
await changeLead(nextLead);
assert.equal((await db.query('SELECT assembler_id FROM public.bookings')).rows[0].assembler_id,nextLead,'normal no-crew accepted handoff works');
await changeLead(oldLead);
for(const role of ['lead','helper']){
  for(const payout of ['owed','paid','void']){
    await db.exec('TRUNCATE public.booking_crew');
    await db.query('INSERT INTO public.booking_crew(booking_id,easer_id,role,due_cents,payout_status) VALUES($1,$2,$3,12345,$4)',[bookingId,oldLead,role,payout]);
    const before=(await db.query('SELECT * FROM public.booking_crew')).rows;
    for(const target of [nextLead,null]){
      await assert.rejects(changeLead(target),err=>err.code==='23514'&&/Active crew allocations/.test(err.message),`${role}/${payout} cannot be orphaned`);
      assert.equal((await db.query('SELECT assembler_id FROM public.bookings')).rows[0].assembler_id,oldLead);
      assert.deepEqual((await db.query('SELECT * FROM public.booking_crew')).rows,before,'pay/history stay intact');
    }
    await changeLead(oldLead); // unrelated self-updates do not trigger a false refusal
  }
}
await db.exec("UPDATE public.booking_crew SET removed_at=now()");
await changeLead(nextLead);
assert.equal((await db.query('SELECT assembler_id FROM public.bookings')).rows[0].assembler_id,nextLead,'removed allocations do not block current work');
await db.exec('TRUNCATE public.booking_crew');
// Simulate the relevant lock ordering: preflight sees no crew, then crew is
// committed before the assignment write. Trigger re-reads instead of trusting
// the application snapshot. PGlite is one connection, not a lock stress test.
assert.equal((await db.query('SELECT count(*)::int AS n FROM public.booking_crew WHERE removed_at IS NULL')).rows[0].n,0);
await db.query('INSERT INTO public.booking_crew(booking_id,easer_id,role,due_cents,payout_status) VALUES($1,$2,\'helper\',5000,\'owed\')',[bookingId,oldLead]);
await assert.rejects(changeLead(oldLead),err=>err.code==='23514');
await db.exec(`GRANT SELECT,UPDATE ON public.bookings TO authenticated;SET ROLE authenticated;`);
// No crew RLS policy exposes rows to this role. SECURITY DEFINER still detects
// the pay allocation, rather than letting an empty RLS view bypass the guard.
await assert.rejects(changeLead(oldLead),err=>err.code==='23514');
await db.exec('RESET ROLE');
const permissions=(await db.query("SELECT has_function_privilege('anon','public.guard_crew_assignment_handoff()','EXECUTE') AS anon,has_function_privilege('authenticated','public.guard_crew_assignment_handoff()','EXECUTE') AS authenticated,has_function_privilege('service_role','public.guard_crew_assignment_handoff()','EXECUTE') AS service")).rows[0];
assert.deepEqual(permissions,{anon:false,authenticated:false,service:true});
assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_schema_state WHERE migration_number=101')).rows[0].n,1);
assert.deepEqual((await db.query('SELECT total_price,payment_status FROM public.bookings')).rows[0],{total_price:21650,payment_status:'authorized'});
await db.close();
console.log('crew assignment handoff SQL: PASS (isolated PostgreSQL; single connection)');
