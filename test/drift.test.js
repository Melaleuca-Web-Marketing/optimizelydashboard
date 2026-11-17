const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprint, diffFingerprints, compactChanges, explainSnippet, buildDrift } = require('../drift');
const { runSecurityScan } = require('../security');
const { createOptimizelyClient } = require('../optimizely');

const exp = (id, code, extra = {}) => ({ kind: 'experiment-code', id, name: 'exp-' + id, status: 'running', variation: 'V1', field: 'value', code, ...extra });
const NOW = Date.parse('2026-11-16T12:00:00Z');
const rec = (type, id, minutesAgo, user = 'a@melaleuca.com', source = 'ui', action = 'update') => ({ created: new Date(NOW - minutesAgo * 60000).toISOString(), user: { email: user }, source, change_type: action, entity: { type, id, name: type + id } });

test('fingerprints hash code (never store it), ignore source order, and merge an experiment\'s code and widget settings', () => {
  const a = fingerprint([exp('1', 'x()'), { kind: 'widget-config', id: '1', name: 'exp-1', variation: 'V1', field: 'config:w', code: '{"a":1}' }]);
  const b = fingerprint([{ kind: 'widget-config', id: '1', name: 'exp-1', variation: 'V1', field: 'config:w', code: '{"a":1}' }, exp('1', 'x()')]);
  assert.deepEqual(a, b);
  assert.equal(Object.keys(a).length, 1);
  assert.ok(a['experiment:1']);
  assert.ok(!JSON.stringify(a).includes('x()'));
  assert.notDeepEqual(fingerprint([exp('1', 'x()')]), fingerprint([exp('1', 'y()')]));
});
test('diff reports added, changed and removed entities', () => {
  const prev = fingerprint([exp('1', 'a'), exp('2', 'b'), exp('3', 'c')]);
  const next = fingerprint([exp('1', 'a'), exp('2', 'B'), exp('4', 'd')]);
  assert.deepEqual(diffFingerprints(prev, next), { added: ['experiment:4'], removed: ['experiment:3'], changed: ['experiment:2'] });
});
test('a code change with a matching change-history entry is attributed; one without is flagged; removals are not flagged', () => {
  const previous = { fetchedAt: new Date(NOW - 3600000).toISOString(), fingerprints: fingerprint([exp('1', 'a'), exp('2', 'b'), exp('3', 'c')]) };
  const sources = [exp('1', 'a'), exp('2', 'B'), exp('4', 'd')];
  const events = compactChanges([rec('experiment', '2', 20, 'jane@melaleuca.com', 'ui'), rec('experiment', '9', 5), rec('experiment', '4', 5000)]);
  const { drift, findings } = buildDrift({ sources, previous, history: { events, windowStart: NOW - 45 * 86400000 }, snippet: null });
  assert.equal(drift.changed[0].by[0].user, 'jane@melaleuca.com');
  assert.equal(drift.changed[0].unexplained, false);
  assert.equal(drift.added[0].id, '4');
  assert.equal(drift.added[0].unexplained, true, 'the only entry for experiment 4 predates the previous scan window');
  assert.equal(drift.removed[0].id, '3');
  assert.equal(drift.removed[0].unexplained, false);
  assert.deepEqual(findings.map(f => f.rule), ['unexplained-code-change']);
  assert.equal(findings[0].severity, 'high');
  assert.equal(drift.counts.unexplained, 1);
});
test('no baseline means no drift or alerts; unavailable change history means no false "unexplained" alerts', () => {
  const sources = [exp('1', 'a')];
  assert.deepEqual(buildDrift({ sources, previous: null, history: { events: [], windowStart: 0 }, snippet: null }).findings, []);
  const previous = { fetchedAt: new Date(NOW - 3600000).toISOString(), fingerprints: fingerprint([exp('1', 'old')]) };
  const r = buildDrift({ sources, previous, history: null, snippet: null });
  assert.equal(r.drift.changed.length, 1);
  assert.equal(r.drift.historyAvailable, false);
  assert.deepEqual(r.findings, []);
});
test('snippet modification time is matched to a change-history entry within minutes', () => {
  const events = compactChanges([rec('campaign', '5', 60, 'jane@melaleuca.com', 'ui', 'publish')]);
  const t = new Date(NOW - 60 * 60000 + 44000).toUTCString();
  const ok = explainSnippet(t, events, NOW - 86400000);
  assert.equal(ok.status, 'explained'); assert.equal(ok.by[0].user, 'jane@melaleuca.com');
  assert.equal(explainSnippet(new Date(NOW - 30 * 60000).toUTCString(), events, NOW - 86400000).status, 'unexplained');
  assert.equal(explainSnippet(new Date(NOW - 90 * 86400000).toUTCString(), events, NOW - 86400000).status, 'outside-window');
  assert.equal(explainSnippet(null, events, 0).status, 'unknown');
  const f = buildDrift({ sources: [], previous: null, history: { events, windowStart: NOW - 86400000 }, snippet: { lastModified: new Date(NOW - 30 * 60000).toUTCString() } }).findings;
  assert.deepEqual(f.map(x => x.rule), ['unexplained-snippet']);
});

function mockClient({ code, records, snippetLastModified }) {
  return { securitySources: async () => ({ project: {}, pages: [], extensions: [], audiences: [], apiCalls: 1, experiments: [{ id: 7, name: 'E', status: 'running', variations: [{ name: 'V', actions: [{ changes: [{ type: 'custom_code', value: code }] }] }] }] }),
    projectChanges: async () => ({ records, truncated: false }),
    snippet: async () => ({ text: 'ok', bytes: 2, sha256: 'a'.repeat(64), lastModified: snippetLastModified }) };
}
test('end to end: first scan sets the baseline, the second reports a change with who changed it', async () => {
  const project = { id: '1', name: 'P' };
  const t0 = Date.now();
  const first = await runSecurityScan(mockClient({ code: 'a()', records: [], snippetLastModified: new Date(t0 - 86400000 * 100).toUTCString() }), project);
  assert.equal(first.drift.baselineAt, null);
  assert.ok(first.fingerprints['experiment:7']);
  const edited = { created: new Date().toISOString(), user: { email: 'sam@melaleuca.com' }, source: 'api', change_type: 'update', entity: { type: 'experiment', id: 7, name: 'E' } };
  const second = await runSecurityScan(mockClient({ code: 'b()', records: [edited], snippetLastModified: new Date().toUTCString() }), project, first);
  assert.equal(second.drift.counts.changed, 1);
  assert.equal(second.drift.changed[0].by[0].user, 'sam@melaleuca.com');
  assert.equal(second.drift.changed[0].by[0].source, 'api');
  assert.equal(second.recentChanges.length, 1);
  const third = await runSecurityScan(mockClient({ code: 'c()', records: [], snippetLastModified: new Date().toUTCString() }), project, second);
  assert.deepEqual(third.findings.map(f => f.rule).sort(), ['unexplained-code-change', 'unexplained-snippet']);
});
test('projectChanges pages through the change log and reports truncation', async () => {
  let pages = 0;
  const client = createOptimizelyClient({ token: 't', projectId: '9', spacingMs: 0, fetchImpl: async target => {
    pages++; const url = new URL(target);
    assert.equal(url.pathname, '/v2/changes'); assert.equal(url.searchParams.get('project_id'), '9'); assert.equal(url.searchParams.get('entity'), null);
    return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: pages * 1000 + i }))));
  } });
  const r = await client.projectChanges({ start: Date.now() - 1000, end: Date.now(), maxPages: 3 });
  assert.equal(pages, 3); assert.equal(r.records.length, 300); assert.equal(r.truncated, true);
});
