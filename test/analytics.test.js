const test=require('node:test');
const assert=require('node:assert/strict');
const {campaignAnalytics}=require('../analytics');
const {summarize}=require('../model');
const promo={id:'20261101|20261131|60298',name:'',creative:'Count Down to Christmas|V1|Tenured_var_2',position:'ps_2_c_var_2'};
function extract(changes,extras={}) {
  return campaignAnalytics({},[{id:10,name:'English experience',status:'running',variations:[{variation_id:20,name:'Variation 2',weight:2500,actions:[{page_id:30,changes}],...extras}]}]);
}
test('HTML promo attributes decode entities and retain empty values and exact IDs',()=>{
  const encoded=JSON.stringify(promo).replaceAll('"','&quot;');
  const html=`<a data-opt-promo="${encoded}">Christmas</a><div data-gtm-promo='${JSON.stringify({...promo,creative:'Baking &amp; gifts'})}'></div>`;
  const result=extract([{id:'change1',type:'insert_html',selector:'#offers',value:html}]);
  assert.equal(result.records.length,2);
  const a=result.records[0];assert.equal(a.attribute,'data-opt-promo');assert.deepEqual(a.payload,promo);assert.equal(a.payload.name,'');
  assert.equal(a.experienceId,'10');assert.equal(a.variationId,'20');assert.equal(a.percent,25);assert.equal(a.pageId,'30');assert.equal(a.selector,'#offers');
  assert.equal(result.records[1].payload.creative,'Baking & gifts');
});
test('attribute edits and nested extension JSON expose tracking metadata without executing code',()=>{
  const result=extract([{type:'attribute',attributes:{'data-opt-promo':JSON.stringify(promo)}},{type:'extension',config:{slides_json:JSON.stringify([{gtmPromo:promo}])}}]);
  assert.equal(result.records.length,2);assert.deepEqual(result.records[0].payload,promo);
  assert.equal(result.records[1].attribute,'gtmPromo (extension config)');assert.deepEqual(result.records[1].payload,promo);
  assert.match(result.records[1].path,/slides_json.*gtmPromo/);
});
test('shared, archived, zero-weight and duplicate promotion metadata retain their scope',()=>{
  const html=`<a data-opt-promo='${JSON.stringify(promo)}'></a>`;
  const change={id:'x',type:'insert_html',value:html+html};
  const e={id:10,name:'E',changes:[{id:'shared',attributes:{'data-gtm-promo':promo}}],variations:[{name:'Off',weight:0,actions:[{changes:[change]}]},{name:'Old',archived:true,actions:[{changes:[change]}]}]};
  const result=campaignAnalytics({changes:[{id:'campaign',attributes:{'data-opt-promo':promo}}]},[e]);
  assert.equal(result.records.length,3);assert.equal(result.records[0].scope,'Campaign shared');assert.equal(result.records[1].scope,'Experience shared');
  assert.equal(result.records[2].variationName,'Off');assert.equal(result.records[2].percent,0);assert.equal(result.records[2].occurrences,2);
  assert.equal(campaignAnalytics(e,[e],true).records.filter(r=>r.changeId==='shared').length,1);
});
test('malformed and dynamic values remain visible without inventing analytics values',()=>{
  const result=extract([{value:'<div data-opt-promo="{&quot;id&quot;:}"></div>'},{value:`el.setAttribute('data-opt-promo', JSON.stringify(buildPromo())); el.dataset.gtmPromo = runtimeValue;`},{value:`el.setAttribute('data-gtm-promo', '${JSON.stringify(promo)}')`}]);
  assert.deepEqual(result.records.map(r=>r.status),['invalid','dynamic','dynamic','parsed']);
  assert.equal(result.records[1].payload,null);assert.deepEqual(result.records[3].payload,promo);
  assert.equal(extract([{value:"document.querySelector('[data-opt-promo]')"}]).records.length,0);
});
test('external code is reported as uninspected and code payloads are never executed',()=>{
  global.analyticsShouldNotRun=false;
  const result=extract([{async:true,src:'https://example.com/code.js'},{value:`global.analyticsShouldNotRun=true; el.setAttribute('data-opt-promo', getPromo());`}]);
  assert.equal(global.analyticsShouldNotRun,false);delete global.analyticsShouldNotRun;
  assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/externally/);assert.equal(result.records[0].status,'dynamic');
});
test('model stores only extracted analytics values and preserves variation attribution',()=>{
  const raw={project_id:'1',campaigns:[],pages:[],audiences:[],experiments:[{id:10,name:'Standalone',type:'a/b',status:'running',variations:[{name:'B',weight:10000,actions:[{changes:[{type:'insert_html',value:`<b data-opt-promo='${JSON.stringify(promo)}'>Large private HTML</b>`}]}]}]}]};
  const out=summarize(raw);assert.equal(out.schemaVersion,6);assert.equal(out.items[0].analytics.records[0].variationName,'B');
  assert.equal(JSON.stringify(out).includes('Large private HTML'),false);
});
