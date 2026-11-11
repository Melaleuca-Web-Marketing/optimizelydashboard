const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { classList: { toggle() {} }, setAttribute(name, value) { this[name] = value; } }); return elements.get(id); }, querySelectorAll() { return []; } };
  const context = vm.createContext({ document });
  const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(script.slice(0, script.indexOf("$('rows').onclick")), context);
  const record = { attribute: 'data-opt-promo', status: 'parsed', payload: { id: '001|002|003', name: '', creative: '<Holiday>', position: 'ps_2' }, experienceName: 'US English', variationName: 'V1', percent: 100, scope: 'Variation', changeType: 'insert_html' };
  const campaign = { id: '1', apiName: 'camp-holiday', annotation: { name: 'Holiday', area: 'Home\n/' }, audiences: [], pages: [], analytics: { records: [record, { ...record, experienceName: 'CA English', percent: 0 }], warnings: [] } };
  context.items = [campaign];
  vm.runInContext("state.mode='analytics';state.query='';state.promoCoverage='all'", context);
  return { context, elements, campaign, record, run: code => vm.runInContext(code, context) };
}

test('analytics overview combines identical values while preserving placements and escaped content', () => {
  const { run, elements } = setup();
  run('renderOverview(items)');
  const html = elements.get('promoCampaigns').innerHTML;
  assert.match(html, /1 distinct values · 2 placements/);
  assert.match(html, /&lt;Holiday&gt;/);
  assert.match(html, /001\|002\|003/);
  assert.match(html, /\(blank\)/);
  assert.match(html, /US English/);
  assert.match(html, /CA English/);
  assert.match(html, /0% traffic \(not receiving traffic\)/);
  assert.equal((html.match(/<tr><td>/g) || []).length, 1);
});

test('analytics search selects matching placements and attribute filters exclude other attributes', () => {
  const { run, campaign, record } = setup();
  campaign.analytics.records.push({ ...record, payload: { ...record.payload, position: 'another_position' } });
  run("state.query='ps_2'");
  assert.equal(run('overviewCampaigns(items)[0].records.length'), 2);
  run("state.promoAttribute='data-gtm-promo'");
  assert.equal(run('overviewCampaigns(items).length'), 0);
  run("state.promoAttribute='all';state.query='holiday'");
  assert.equal(run('overviewCampaigns(items)[0].records.length'), 3);
});

test('coverage filters distinguish no extracted records from values needing review', () => {
  const { run, context, campaign, record } = setup();
  context.items.push({ ...campaign, id: '2', analytics: { records: [], warnings: [] } });
  campaign.analytics.records.push({ ...record, status: 'invalid', payload: null, raw: '<broken>' });
  run("state.promoCoverage='none'");
  assert.equal(run('overviewCampaigns(items)[0].c.id'), '2');
  run("state.promoCoverage='review'");
  assert.equal(run('overviewCampaigns(items).length'), 1);
  run('renderOverview(items)');
  assert.match(run("document.getElementById('promoCampaigns').innerHTML"), /Invalid JSON/);
  assert.match(run("document.getElementById('promoCampaigns').innerHTML"), /&lt;broken&gt;/);
});

test('review shortcut filters individual records, including the export selection, and removes valid status badges', () => {
  const { run, campaign, record, elements } = setup();
  campaign.analytics.records.push({ ...record, status: 'dynamic', payload: null, raw: 'computed()' });
  run('state.reviewOnly=true;renderOverview(items)');
  assert.equal(run('overviewCampaigns(items)[0].records.length'), 1);
  assert.match(elements.get('promoCampaigns').innerHTML, /Dynamic value/);
  assert.doesNotMatch(elements.get('promoCampaigns').innerHTML, /&lt;Holiday&gt;/);
  assert.equal(elements.get('reviewOnly')['aria-pressed'], 'true');
  run('state.reviewOnly=false;renderOverview(items)');
  assert.doesNotMatch(elements.get('promoCampaigns').innerHTML, />Parsed</);
});

test('collapsed campaigns stay collapsed across renders and do not carry over to another project', () => {
  const { run, elements } = setup();
  run("state.projectId='us';campaignExpansion.set(campaignKey('1'),false);renderOverview(items)");
  assert.match(elements.get('promoCampaigns').innerHTML, /aria-expanded="false"/);
  assert.match(elements.get('promoCampaigns').innerHTML, /class="campaign-promo-body" hidden/);
  run('renderOverview(items)');
  assert.match(elements.get('promoCampaigns').innerHTML, /aria-expanded="false"/);
  run("state.projectId='mx';renderOverview(items)");
  assert.match(elements.get('promoCampaigns').innerHTML, /aria-expanded="true"/);
});

test('history summaries and code diffs are escaped and absent values remain distinguishable', () => {
  const { run, context, elements } = setup();
  context.historyData = { fetchedAt:'2026-11-11T00:00:00Z', hasMore:true, records:[{
    id:'1',created:'2026-11-01T00:00:00Z',actor:'<Person>',action:'update',summary:'<img src=x onerror=bad()>',
    entity:{type:'experiment',name:'<Experience>'},source:'api',changes:[{property:'html',description:'Updated HTML',before:null,after:'<script>bad()</script>',afterTruncated:true}]
  }] };
  run("document.getElementById('historySearch').value='';renderHistoryRecords(historyData)");
  const html=elements.get('historyRecords').innerHTML;
  assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html,/&lt;Person&gt;/);assert.match(html,/Not set/);assert.match(html,/value shortened/);
  assert.doesNotMatch(html,/<script>|<img/);
});

test('history analytics filter shows semantic comparisons safely and keeps ordinary history available', () => {
  const { run, context, elements } = setup();
  const record={id:'1',created:'2026-11-01T00:00:00Z',actor:'Person',action:'update',summary:'Tracking edit',entity:{type:'experiment',name:'Experience'},source:'ui',changes:[]};
  context.historyData={records:[{...record,analyticsDiff:{items:[{kind:'changed',attribute:'data-opt-promo',location:'#hero',property:'variations',fields:[{key:'creative',before:'<Old>',after:'<New>'}]}],warnings:[]}},{...record,id:'2',summary:'Renamed campaign',analyticsDiff:{items:[],warnings:[]}}]};
  run("document.getElementById('historySearch').value='';historyAnalyticsOnly=true;renderHistoryRecords(historyData)");
  let html=elements.get('historyRecords').innerHTML;
  assert.match(html,/Analytics changed/);assert.match(html,/&lt;Old&gt;/);assert.match(html,/&lt;New&gt;/);assert.doesNotMatch(html,/Renamed campaign/);
  run('historyAnalyticsOnly=false;renderHistoryRecords(historyData)');
  assert.match(elements.get('historyRecords').innerHTML,/Renamed campaign/);
});

test('old history cache requests a manual refresh for analytics comparisons without trying to re-fetch it', () => {
  const { run, context, elements } = setup();
  context.historyData={records:[{created:'2026-11-01',actor:'Person',action:'update',summary:'Old cached entry',entity:{type:'campaign',name:'Campaign'},source:'ui',changes:[]}]};
  run("document.getElementById('historySearch').value='';renderHistory(historyData)");
  assert.match(elements.get('historyStatus').textContent,/cached entries predate analytics comparisons/);
});
