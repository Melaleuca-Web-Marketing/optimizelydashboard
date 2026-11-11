const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptimizelyClient } = require('../optimizely');
const { summarize } = require('../model');

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
