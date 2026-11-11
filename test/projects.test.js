const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptimizelyClient } = require('../optimizely');
const { summarize } = require('../model');
const { PROJECTS } = require('../projects');

test('all configured projects support the same custom fields and use their own project query and name', async () => {
  assert.equal(PROJECTS.length, 3);
  for (const project of PROJECTS) {
    const client = createOptimizelyClient({ token: 'test', projectId: project.id, projectName: project.name, spacingMs: 0, fetchImpl: async target => {
      const url = new URL(target);
      assert.equal(url.searchParams.get('project_id'), project.id);
      const data = url.pathname.endsWith('/campaigns') ? [{ id: 1, status: 'running', custom_field_values: { 'campaign-descriptive-name': 'Readable ' + project.market, assignment: 'Owner', 'user-story': 123, design: 'https://figma.com/design/example' } }] : [];
      return new Response(JSON.stringify(data));
    } });
    const snapshot = await client.snapshot();
    assert.equal(snapshot.projectName, project.name);
    assert.equal(snapshot.items[0].customFields['campaign-descriptive-name'], 'Readable ' + project.market);
    assert.equal(Object.keys(snapshot.items[0].customFields).length, 4);
    assert.ok(snapshot.items[0].link.includes('/projects/' + project.id + '/'));
  }
});

test('EU country hosts, locales and preview environments are classified without hiding EU campaigns', () => {
  const countries = [['ie','en-IE'], ['uk','en-GB'], ['nl','nl-NL'], ['de','de-DE'], ['pl','pl-PL'], ['lt','lt-LT']];
  const snapshot = summarize({ project_id: '6276897508687872', campaigns: [], pages: [],
    audiences: countries.map(([country,locale], i)=>({id:i+1,name:country,conditions:['and',{name:'Culture',value:locale}]})),
    experiments: countries.map(([country],i)=>({id:i+1,status:'running',type:'a/b',audience_conditions:['and',{audience_id:i+1}],url_targeting:{conditions:['and',{type:'url',value:`https://${country}.melaleuca.com/`,match_type:'simple'}]}})).concat([
      { id: 7, status: 'running', type: 'a/b', url_targeting: { conditions: ['and', { type: 'url', value: 'https://productstore2-uatuk.melaleuca.com/' }] } },
      { id: 8, status: 'running', type: 'a/b' }
    ])
  });
  for (let i=0;i<6;i++) {
    const item=snapshot.items.find(item=>item.id===String(i+1));
    assert.equal(item.region,'eu');
    assert.deepEqual(item.environments,['production']);
    assert.deepEqual(item.locales,[countries[i][1].toLowerCase().replace('-','')]);
  }
  assert.deepEqual(snapshot.items.find(item=>item.id==='7').environments,['uat']);
  assert.equal(snapshot.items.find(item=>item.id==='8').region,'eu');
});

test('US/CA and MX clients keep project filters, names and custom fields separate', async () => {
  const fetchImpl = async target => {
    const url = new URL(target), id = url.searchParams.get('project_id');
    assert.ok(['5443948697616384', '5730256506585088'].includes(id));
    return new Response(JSON.stringify(url.pathname.endsWith('/campaigns') ? [{ id: 1, name: id, status: 'running', custom_field_values: { 'campaign-descriptive-name': id, 'assignment': id, 'user-story': 123, design: 'https://figma.com/design/' + id } }] : []));
  };
  const us = createOptimizelyClient({ token: 'test', projectId: '5443948697616384', projectName: 'US/CA', fetchImpl, spacingMs: 0 });
  const mx = createOptimizelyClient({ token: 'test', projectId: '5730256506585088', projectName: 'MX', fetchImpl, spacingMs: 0 });
  const [a,b] = await Promise.all([us.snapshot(), mx.snapshot()]);
  assert.equal(a.projectName, 'US/CA');assert.equal(b.projectName, 'MX');
  assert.notEqual(a.items[0].customFields.assignment, b.items[0].customFields.assignment);
  assert.match(b.items[0].customFields.design, /5730256506585088$/);
  assert.match(b.items[0].link, /projects\/5730256506585088\//);
  assert.equal(b.items[0].region, 'mx');
});

test('MX production and preview targeting remain visible in the correct market and environment', () => {
  const snapshot = summarize({ project_id: '5730256506585088', campaigns: [], audiences: [], pages: [], experiments: [
    { id: 1, status: 'running', type: 'a/b', url_targeting: { conditions: ['and', { type: 'url', value: 'https://mx.melaleuca.com/', match_type: 'simple' }] } },
    { id: 2, status: 'running', type: 'a/b', url_targeting: { conditions: ['and', { type: 'url', value: 'https://productstore2-uatmx.melaleuca.com/', match_type: 'simple' }] } }
  ] });
  assert.equal(snapshot.items.find(i=>i.id==='1').region, 'mx');
  assert.deepEqual(snapshot.items.find(i=>i.id==='1').environments, ['production']);
  assert.deepEqual(snapshot.items.find(i=>i.id==='2').environments, ['uat']);
});
