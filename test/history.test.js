const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore, normalizeChanges } = require('../history');
const { createOptimizelyClient } = require('../optimizely');
const { summarize } = require('../model');
const DAY = 86400000;
const entities = [{ type: 'campaign', id: '1' }, { type: 'experiment', id: '2' }, { type: 'variation', id: '3' }];
const item = { id: '1', historyEntities: entities, historyStart: '2026-08-01T00:00:00Z' };
const change = (id, extra = {}) => ({ id, project_id: 10, created: '2026-11-01T12:00:00Z', change_type: 'update', summary: '<Changed>', source: 'ui', user: { display_name: 'Person' }, entity: { type: 'campaign', id: 1, name: '<Campaign>' }, changes: [{ property: 'name', before: '', after: '<script>bad()</script>' }], ...extra });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('history is lazy, shared across concurrent requests and disk restarts, and respects TTL and refresh cooldown', async t => {
  const directory = await fixture(t);let now = Date.parse('2026-11-11T12:00:00Z'), calls = 0;
  const options = { directory, projectId: '10', now: () => now, loadPage: async () => { calls++;await new Promise(r=>setTimeout(r,5));return { records: [change(1)], hasMore: false }; } };
  const store = new HistoryStore(options);assert.equal(calls,0);
  const results = await Promise.all(Array.from({length:10},()=>store.read(item)));
  assert.equal(calls,1);assert.equal(results[0].records.length,1);
  await store.read(item,{action:'refresh'});assert.equal(calls,1);
  await new HistoryStore(options).read(item);assert.equal(calls,1);
  now+=DAY+1;await store.read(item);assert.equal(calls,2);
  now+=60001;await store.read(item,{action:'refresh'});assert.equal(calls,3);
});

test('older history advances pages before date windows, deduplicates IDs, and ignores repeated cursors', async t => {
  const directory=await fixture(t), queries=[];
  const store=new HistoryStore({directory,projectId:'10',now:()=>Date.parse('2026-11-11T12:00:00Z'),loadPage:async q=>{
    queries.push(q);return {records:q.page===1?[change(1)]:[change(1),change(2)],hasMore:q.page===1 && queries.length===1};
  }});
  const first=await store.read(item);
  const second=await store.read(item,{action:'older',cursor:first.cursor});
  assert.equal(queries[1].page,2);assert.equal(queries[0].start,queries[1].start);assert.equal(second.records.length,2);
  await store.read(item,{action:'older',cursor:first.cursor});assert.equal(queries.length,2);
  await store.read(item,{action:'older',cursor:second.cursor});
  assert.equal(queries[2].page,1);assert.equal(queries[2].end,queries[0].start);assert.ok(queries[2].start<queries[0].start);
});

test('history failures keep saved entries and retry backoff persists across restart', async t => {
  const directory=await fixture(t);let now=Date.parse('2026-11-11T12:00:00Z'),fail=false,calls=0;
  const options={directory,projectId:'10',now:()=>now,loadPage:async()=>{calls++;if(fail){const e=Error('no');e.retryAfterMs=120000;throw e;}return{records:[change(1)],hasMore:false};}};
  const store=new HistoryStore(options);await store.read(item);now+=60001;fail=true;
  const failed=await store.read(item,{action:'refresh'});assert.equal(failed.records.length,1);assert.ok(failed.error);
  await new HistoryStore(options).read(item,{action:'older',cursor:failed.cursor});assert.equal(calls,2);
  now+=120001;fail=false;const result=await store.read(item,{action:'refresh'});assert.equal(result.error,null);assert.equal(calls,3);
});

test('history normalizes only scoped project records and bounds large diff values without executing them', () => {
  const records=normalizeChanges([change(1),change(2,{project_id:99}),change(3,{entity:{type:'campaign',id:99}}),change(4,{changes:[{property:'html',after:'x'.repeat(9000)}]})],'10',entities);
  assert.equal(records.length,2);assert.equal(records[0].changes[0].before,'');assert.equal(records[0].changes[0].after,'<script>bad()</script>');
  assert.equal(records[1].changes[0].after.length,4000);assert.equal(records[1].changes[0].afterTruncated,true);assert.equal(records[1].changes[0].before,null);
  assert.equal(records[0].user,undefined);
});

test('history API batches entity filters in one bounded page and rejects untrusted pagination', async () => {
  let calls=0;
  const client=createOptimizelyClient({token:'test',projectId:'10',spacingMs:0,fetchImpl:async target=>{
    calls++;const u=new URL(target);assert.equal(u.pathname,'/v2/changes');assert.deepEqual(u.searchParams.getAll('entity'),['campaign:1','experiment:2','variation:3']);assert.equal(u.searchParams.get('per_page'),'50');
    return new Response(JSON.stringify([change(1)]),{headers:{link:'<https://evil.example/steal>; rel="next"'}});
  }});
  await assert.rejects(client.historyPage({entities,page:1,start:Date.parse('2026-10-01'),end:Date.parse('2026-11-01')}),/pagination host/);assert.equal(calls,1);
});

test('campaign history retains paused experiences and archived variations without adding them to running totals', () => {
  const d=summarize({project_id:'10',campaigns:[{id:1,status:'running'}],experiments:[{id:2,campaign_id:1,status:'paused',variations:[{id:3,archived:true}]}],pages:[],audiences:[]});
  assert.equal(d.items[0].experienceCount,0);assert.deepEqual(d.items[0].historyEntities,entities);
});

test('history chunks large scopes and keeps projects and campaigns isolated', async t => {
  const directory=await fixture(t);let calls=0;
  const itemMany={id:'1',historyEntities:Array.from({length:112},(_,i)=>({type:'experiment',id:String(i+1)}))};
  const options={directory,projectId:'10',loadPage:async q=>{calls++;assert.ok(q.entities.length<=50);return {records:[],hasMore:false};}};
  await new HistoryStore(options).read(itemMany);assert.equal(calls,3);
  await new HistoryStore({...options,projectId:'11'}).read(itemMany);assert.equal(calls,6);
  await new HistoryStore(options).read({...itemMany,id:'2'});assert.equal(calls,9);
});

test('a rate-limited history page blocks subsequent project requests before another API call', async () => {
  let calls=0;
  const client=createOptimizelyClient({token:'test',projectId:'10',spacingMs:0,fetchImpl:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'120'}});}});
  const query={entities,page:1,start:Date.parse('2026-10-01'),end:Date.parse('2026-11-01')};
  await assert.rejects(client.historyPage(query));
  await assert.rejects(client.historyPage({...query,entities:[{type:'campaign',id:'99'}]}),/cooldown/);
  assert.equal(calls,1);
});
