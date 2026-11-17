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

const { scanSnippet, runSecurityScan } = require('../security');
const RUNTIME = 'var a=eval("1");document.cookie;fetch("/x");String.fromCharCode(65);document.createElement("script");var re=//i.test(url.pathname);var u="https://cdn.optimizely.com/js/1.js"';
test('snippet mode ignores Optimizely runtime noise but still flags the IOC, atob and unknown hosts', () => {
  assert.deepEqual(scanSnippet(RUNTIME), []);
  const r = scanSnippet(RUNTIME + ';atob("x");load("https://cdn.1688360.cc/a.js");load("https://other.example.net/b.js")');
  assert.deepEqual(r.map(f => f.rule).sort(), ['atob', 'external-url', 'external-url', 'ioc-domain']);
  assert.ok(r.filter(f => f.severity === 'critical').length >= 2);
});
test('snippet() fetches only the project CDN url, hashes it and refuses redirects and oversize bodies', async () => {
  let call;
  const make = impl => createOptimizelyClient({ token: 't', projectId: '77', spacingMs: 0, fetchImpl: async (u, o) => { call = { u: String(u), o }; return impl(); } });
  const s = await make(() => new Response('abc', { headers: { 'last-modified': 'x', etag: '"e"' } })).snippet();
  assert.equal(call.u, 'https://cdn.optimizely.com/js/77.js'); assert.equal(call.o.redirect, 'error');
  assert.equal(s.bytes, 3); assert.equal(s.sha256.length, 64); assert.equal(s.etag, '"e"');
  await assert.rejects(make(() => new Response('abcd')).snippet({ maxBytes: 3 }), /too large/);
  await assert.rejects(make(() => new Response('', { status: 503 })).snippet(), /Snippet HTTP 503/);
});
test('runSecurityScan merges snippet findings, tracks change vs previous scan, and survives a snippet failure', async () => {
  const project = { id: '77', name: 'P' };
  const base = { securitySources: async () => ({ project: {}, experiments: [], pages: [], extensions: [], apiCalls: 4 }) };
  const first = await runSecurityScan({ ...base, snippet: async () => ({ text: 'x(atob("a"))', bytes: 12, sha256: 'a'.repeat(64), lastModified: 'L', etag: 'E' }) }, project);
  assert.equal(first.snippet.changedSinceLastScan, null);
  assert.ok(first.findings.some(f => f.kind === 'published-snippet' && f.rule === 'atob'));
  assert.equal(first.counts.high, 1);
  const second = await runSecurityScan({ ...base, snippet: async () => ({ text: 'ok', bytes: 2, sha256: 'b'.repeat(64) }) }, project, first);
  assert.equal(second.snippet.changedSinceLastScan, true);
  assert.equal(second.findings.length, 0);
  const failed = await runSecurityScan({ ...base, snippet: async () => { const e = new Error('x'); e.publicMessage = 'down'; throw e; } }, project);
  assert.equal(failed.snippet.error, 'down');
});

const { PROJECTS, SECURITY_PROJECTS } = require('../projects');
test('security project list covers every dashboard project, with unique numeric ids', () => {
  const ids = SECURITY_PROJECTS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^\d+$/.test(id)));
  for (const p of PROJECTS) assert.ok(ids.includes(p.id), p.name);
  assert.equal(PROJECTS.length, 3);
});
