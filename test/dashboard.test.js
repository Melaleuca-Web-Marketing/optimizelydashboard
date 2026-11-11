const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SnapshotCache } = require('../cache');
const { summarize, isWelcome } = require('../model');
const { createOptimizelyClient } = require('../optimizely');
const { resolveFields, customFields, storyId } = require('../fields');

test('custom values win independently without overwriting tracker fallbacks or old story titles', () => {
  const annotation = { name:'Tracker name', owner:'Tracker owner', story:'CANDIDATE — Old Story 111111: old title', storyUrl:'https://dev.azure.com/org/project/_workitems/edit/111111' };
  const original = structuredClone(annotation);
  const item = { apiName:'Technical campaign', customFields:{'user-story':362379,'campaign-descriptive-name':'  New readable name  ','assignment':'  '} };
  const result = resolveFields(item, annotation);
  assert.equal(result.name,'New readable name');assert.equal(result.owner,'Tracker owner');
  assert.equal(result.story,'User Story #362379');assert.equal(result.storyUrl,'https://dev.azure.com/MelaleucaPlatform/Melaleuca/_workitems/edit/362379');
  assert.deepEqual(result.sources,{name:'Optimizely',owner:'Tracker fallback',story:'Optimizely',design:'Not provided'});
  assert.deepEqual(annotation,original);
  item.customFields = { assignment:'New owner', 'user-story':'\t ' };
  const fallback = resolveFields(item,annotation);
  assert.equal(fallback.name,'Tracker name');assert.equal(fallback.owner,'New owner');assert.equal(fallback.story,annotation.story);assert.equal(fallback.storyUrl,annotation.storyUrl);
});

test('story IDs reject malformed, fractional, nonpositive and unsafe numbers', () => {
  for (const value of [0,-1,1.5,true,[],{},'362,379','1e5','https://example.com','123abc',Number.MAX_SAFE_INTEGER+1]) {
    assert.equal(storyId(value),null,String(value));
    const result = resolveFields({apiName:'API',customFields:{'user-story':value}},{story:'Saved story',storyUrl:'saved-link'});
    assert.equal(result.story,'Saved story');assert.equal(result.storyUrl,'saved-link');assert.equal(result.warnings.length,1);
  }
  for(const value of [362379,'362379',' 362379 ','362379.0'])assert.equal(storyId(value),'362379');
  const missing = resolveFields({apiName:'API',customFields:{'user-story':null,'campaign-descriptive-name':'   '}});
  assert.equal(missing.name,'API');assert.equal(missing.sources.name,'API name');assert.equal(missing.storyUrl,'');assert.equal(missing.sources.story,'Not provided');assert.deepEqual(missing.warnings,[]);
});

test('parent fields, inherited fields, standalone tests and conflicts resolve without arbitrary matches', () => {
  const experiences = [{custom_field_values:{assignment:'A','user-story':1}},{custom_field_values:{assignment:'B','user-story':1}}];
  const fields = customFields({custom_field_values:{assignment:'Parent owner'}},experiences);
  assert.equal(fields.values.assignment,'Parent owner');assert.equal(fields.values['user-story'],1);
  const conflict = customFields({},experiences);assert.equal(conflict.values.assignment,undefined);assert.equal(conflict.warnings.length,1);
  const result = resolveFields({apiName:'API',customFields:conflict.values,customFieldWarnings:conflict.warnings},{owner:'Saved owner'});
  assert.equal(result.owner,'Saved owner');assert.equal(result.warnings.length,1);
  assert.equal(customFields({custom_field_values:{assignment:''}},experiences).values.assignment,'');
  const raw={project_id:'1',campaigns:[{id:1,status:'running',custom_field_values:{'campaign-descriptive-name':'Campaign name'}}],experiments:[{id:2,campaign_id:1,status:'running',custom_field_values:{'user-story':123}},{id:3,campaign_id:999,type:'a/b',status:'running',custom_field_values:{assignment:'Test owner','user-story':456}}],pages:[],audiences:[]};
  const snapshot=summarize(raw);assert.equal(snapshot.schemaVersion,7);
  assert.equal(resolveFields(snapshot.items.find(c=>c.id==='1')).story,'User Story #123');
  const standalone=resolveFields(snapshot.items.find(c=>c.id==='3'));assert.equal(standalone.owner,'Test owner');assert.equal(standalone.story,'User Story #456');
});

test('the normal Optimizely batch carries custom fields with no Azure DevOps or extra per-row requests', async () => {
  const requests=[];
  const client=createOptimizelyClient({token:'test',projectId:'1',spacingMs:0,fetchImpl:async url=>{
    const u=new URL(url);requests.push(u);assert.equal(u.hostname,'api.optimizely.com');
    const records=u.pathname.endsWith('/campaigns')?[{id:1,status:'running',custom_field_values:{'user-story':362379,'assignment':'Owner'}}]:[];
    return new Response(JSON.stringify(records));
  }});
  const snapshot=await client.snapshot();const result=resolveFields(snapshot.items[0]);
  assert.equal(requests.length,4);assert.equal(result.story,'User Story #362379');assert.equal(result.owner,'Owner');
});
test('shared cache deduplicates concurrent refreshes and survives failure/restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-cache-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); return fs.rm(dir, { recursive:true, force:true }); });
  let now=Date.parse('2026-11-11T18:00:00Z'), count=0, fail=false;
  const options={file:path.join(dir,'snapshot.json'),now:()=>now,ttlMs:900000,cooldownMs:60000,load:async()=>{count++;await new Promise(r=>setTimeout(r,10));if(fail)throw Error('offline');return{items:[{id:'1'}],fetchedAt:new Date(now).toISOString()};}};
  const cache=new SnapshotCache(options);await cache.initialize();
  await Promise.all(Array.from({length:12},()=>cache.read()));assert.equal(count,1);
  await cache.read();await cache.refresh(true);assert.equal(count,1,'cooldown applies to manual refresh too');
  now+=900001;fail=true;const old=await cache.refresh();assert.equal(count,2);assert.equal(old.items.length,1);assert.ok(cache.status().error);assert.equal(cache.status().stale,true);
  await cache.refresh(true);assert.equal(count,2,'failed sync is backed off');
  const restarted=new SnapshotCache(options);await restarted.initialize();assert.equal(restarted.snapshot.items.length,1,'last good snapshot persisted');
});
test('audience grouping respects NOT and does not infer New Welcome from campaign name',()=>{
  const audiences=new Map([['1',{name:'Tenured',conditions:JSON.stringify(['not',{name:'statusL2E',value:'WelcomeProgram'}])}],['2',{name:'Welcome month',conditions:JSON.stringify(['and',{name:'newWelcomeMonth',value:'3'}])}]]);
  assert.equal(isWelcome({audience_conditions:['and',{audience_id:'1'}]},audiences),false);
  assert.equal(isWelcome({audience_conditions:['not',{audience_id:'2'}]},audiences),false);
  assert.equal(isWelcome({audience_conditions:['and',{audience_id:'2'}]},audiences),true);
});
test('running-only model includes standalone tests and keeps exclusions separate from environments',()=>{
  const raw={project_id:'1',retrieved_at:'2026-11-11T00:00:00Z',campaigns:[{id:1,name:'New Welcome name only',status:'running',experiment_priorities:[[10]],page_ids:[2]},{id:3,name:'Paused',status:'paused'}],
    experiments:[{id:10,status:'running',campaign_id:1,audience_conditions:'everyone',traffic_allocation:8000,variations:[{name:'A',weight:5000},{name:'B',weight:5000}]},{id:11,status:'running',type:'a/b',campaign_id:999},{id:12,status:'paused',type:'a/b'},{id:13,status:'running',type:'a/b',campaign_id:3}],
    pages:[{id:2,name:'UAT',conditions:['and',{type:'url',value:'https://productstore2-uatus.melaleuca.com/'},['not',{type:'url',value:'https://www.melaleuca.com/'}]]}],audiences:[]};
  const out=summarize(raw);assert.equal(out.items.length,2);const row=out.items.find(x=>x.id==='1');assert.equal(row.group,'general');assert.deepEqual(row.environments,['uat']);assert.equal(row.experiences[0].eligiblePercent,80);assert.equal(row.experiences[0].variations[0].percent,50);
});
test('pagination is complete and malicious next-page hosts never receive a token',async()=>{
  let calls=0;
  const fetchImpl=async url=>{calls++;const u=new URL(url);const data=u.pathname.endsWith('campaigns')&&u.searchParams.get('page')==='1'?[{id:1,status:'paused'}]:[];return new Response(JSON.stringify(data),{headers:u.pathname.endsWith('campaigns')&&u.searchParams.get('page')==='1'?{link:'<https://api.optimizely.com/v2/campaigns?project_id=1&page=2>; rel="next"'}:{}});};
  const client=createOptimizelyClient({token:'test',projectId:'1',fetchImpl,spacingMs:0});assert.equal((await client.snapshot()).items.length,0);assert.equal(calls,5);
  const unsafe=createOptimizelyClient({token:'test',projectId:'1',spacingMs:0,fetchImpl:async()=>new Response('[]',{headers:{link:'<https://example.com/steal>; rel="next"'}})});
  await assert.rejects(unsafe.snapshot(),/pagination host/);
});
test('rate limit honors Retry-After and surfaces an actionable message',async()=>{
  const client=createOptimizelyClient({token:'test',projectId:'1',spacingMs:0,fetchImpl:async()=>new Response('{}',{status:429,headers:{'retry-after':'120'}})});
  await assert.rejects(client.snapshot(),err=>err.retryAfterMs===120000&&/rate limit/.test(err.publicMessage));
});
test('relative URL targeting prevents a misleading UAT-only conclusion',()=>{
  const raw={project_id:'1',campaigns:[{id:1,status:'running',page_ids:[2]}],experiments:[{id:10,campaign_id:1,status:'running',audience_conditions:'everyone'}],audiences:[],pages:[{id:2,conditions:['or',{type:'url',value:'https://productstore2-uatus.melaleuca.com/'},{type:'url',value:'/riverbendranch/productstore/holiday-gifting'}]}]};
  const row=summarize(raw).items[0];assert.deepEqual(row.environments,['uat','unscoped']);assert.ok(row.warnings.some(w=>w.includes('host/environment')));
});
test('locale extraction supports current Culture and legacy uiCulture attributes',()=>{
  const raw={project_id:'1',campaigns:[{id:1,status:'running'}],experiments:[{id:2,campaign_id:1,status:'running',audience_conditions:['and',{audience_id:10},{audience_id:11}]}],pages:[],audiences:[{id:10,name:'English',conditions:['and',{name:'Culture',value:'en-US'}]},{id:11,name:'French',conditions:['and',{name:'uiCulture',value:'frca'}]}]};
  const row=summarize(raw).items[0];assert.deepEqual(row.locales,['enus','frca']);assert.equal(row.region,'us-ca');
});
