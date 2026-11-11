const test = require('node:test');
const assert = require('node:assert/strict');
const { compareHistoryAnalytics } = require('../analytics-history');
const { normalizeChanges } = require('../history');
const promo = extra => ({ id:'20261101|20261130|60298',name:'',creative:'Christmas|V1|Tenured',position:'ps_2_a',...extra });
const html = (value, encoded=false) => `<a data-opt-promo='${encoded?JSON.stringify(value).replace(/"/g,'&quot;'):JSON.stringify(value)}'>Shop</a>`;
const diff = (before,after,property='value',extra={}) => compareHistoryAnalytics({change_type:'update',changes:[{property,before,after,...extra}]});

test('analytics diff extracts encoded values and highlights only changed fields, including changed promo IDs', () => {
  const result=diff(html(promo(),true),html(promo({id:'20261201|20261231|60298',creative:'Christmas|V2|Tenured'})));
  assert.equal(result.items.length,1);assert.equal(result.items[0].kind,'changed');
  assert.deepEqual(result.items[0].fields.map(f=>f.key),['id','creative']);
  assert.equal(result.items[0].fields[0].before,'20261101|20261130|60298');
  assert.equal(diff(html(promo(),true),html(promo())).items.length,0);
});

test('position edits use unchanged IDs, while duplicate identities do not fabricate pairs', () => {
  const result=diff(html(promo()),html(promo({position:'ps_2_b'})));
  assert.deepEqual(result.items[0].fields,[{key:'position',before:'ps_2_a',after:'ps_2_b'}]);
  const ambiguous=diff(html(promo())+html(promo({creative:'Second'})),html(promo({creative:'Third',position:'new_1'}))+html(promo({creative:'Fourth',position:'new_2'})));
  assert.equal(ambiguous.items.length,1);assert.equal(ambiguous.items[0].kind,'review');assert.deepEqual(ambiguous.items[0].fields,[]);
});

test('stable variation and change IDs retain identity when arrays are reordered', () => {
  const variant = (id,value) => ({id,actions:[{page_id:10,changes:[{id:'change-'+id,type:'insert_html',selector:'#hero',value:html(value)}]}]});
  const a=variant(1,promo()),b=variant(2,promo({position:'other'}));
  assert.equal(diff([a,b],[b,a],'variations').items.length,0);
  const result=diff([a,b],[b,variant(1,promo({creative:'New'}))],'variations');
  assert.equal(result.items.length,1);assert.match(result.items[0].location,/Variation 1/);assert.equal(result.items[0].fields[0].key,'creative');
});

test('added, removed and unknown baselines remain distinguishable', () => {
  assert.equal(diff('',html(promo())).items[0].kind,'added');
  assert.equal(diff(html(promo()),'').items[0].kind,'removed');
  const missing=compareHistoryAnalytics({change_type:'update',changes:[{property:'value',after:html(promo())}]});
  assert.equal(missing.items[0].kind,'review');assert.match(missing.items[0].note,/Before-value/);
  const created=compareHistoryAnalytics({change_type:'create',changes:[{property:'value',after:html(promo())}]});
  assert.equal(created.items[0].kind,'added');
});

test('invalid and dynamic values are review cases and code is never executed', () => {
  const invalid=diff(`<a data-opt-promo='broken'>`,html(promo()));
  assert.equal(invalid.items[0].kind,'review');assert.equal(invalid.items[0].beforeStatus,'invalid');
  const dynamic=diff(`document.body.dataset.optPromo=computeOld();`, `document.body.dataset.optPromo=computeNew();`);
  assert.equal(dynamic.items[0].kind,'review');assert.equal(dynamic.items[0].afterStatus,'dynamic');
  assert.equal(diff('throw Error("never")','throw Error("also never")').items.length,0);
});

test('extension configurations and direct attribute edits preserve blank versus missing values', () => {
  const result=diff({slides_json:JSON.stringify([{gtmPromo:promo()}])},{slides_json:JSON.stringify([{gtmPromo:promo({name:'Holiday'})}])},'config');
  assert.equal(result.items[0].attribute,'gtmPromo (extension config)');
  assert.deepEqual(result.items[0].fields,[{key:'name',before:'',after:'Holiday'}]);
  const before=promo();delete before.name;
  const direct=diff(JSON.stringify(before),JSON.stringify(promo()),'attributes.data-gtm-promo');
  assert.deepEqual(direct.items[0].fields,[{key:'name',before:null,after:''}]);
});

test('analytics comparisons are captured before source truncation and outside the first 30 source properties', () => {
  const row={id:1,project_id:10,entity:{type:'campaign',id:1},changes:[...Array.from({length:30},()=>({property:'other',before:1,after:2})),{property:'html',before:'x'.repeat(5000)+html(promo()),after:'x'.repeat(5000)+html(promo({creative:'New'}))}]};
  const normalized=normalizeChanges([row],'10',[{type:'campaign',id:'1'}])[0];
  assert.equal(normalized.changes.length,30);assert.equal(normalized.extraChanges,1);
  assert.equal(normalized.analyticsDiff.items[0].fields[0].after,'New');
});

test('source replacement and unrelated styling edits do not produce analytics-change noise', () => {
  const source = (id,style) => [{id:1,actions:[{page_id:10,changes:[{id,type:'insert_html',selector:'#hero',value:html(promo())+style}]}]}];
  assert.equal(diff(source('old','<i>old style</i>'),source('new','<i>new style</i>'),'variations').items.length,0);
});

test('duplicate occurrence changes are surfaced and review cases retain available source values', () => {
  const result=diff(html(promo())+html(promo()),html(promo()));
  assert.deepEqual(result.items[0].fields,[{key:'occurrences',before:'2',after:'1'}]);
  const invalid=diff(`<a data-opt-promo='broken'>`,html(promo()));
  assert.match(invalid.items[0].afterRaw,/Christmas/);
});

test('an explicitly null analytics value is distinct from an absent property', () => {
  const before=promo();delete before.name;
  const result=diff(html(before),html(promo({name:null})));
  assert.deepEqual(result.items[0].fields,[{key:'name',before:null,after:'null'}]);
});
