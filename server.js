const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const tls = require('node:tls');
// Honor Windows-managed corporate roots without disabling certificate validation.
if (process.platform === 'win32' && tls.setDefaultCACertificates && tls.getCACertificates) {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}
const { SnapshotCache, atomicJson } = require('./cache');
const { summarize } = require('./model');
const { resolveFields, designUrl } = require('./fields');
const { createOptimizelyClient } = require('./optimizely');
const { publicOrigin, sameOrigin } = require('./deployment');
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/); if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv(path.join(__dirname, '.env')); loadEnv(path.join(__dirname, '..', '.env'));
const allowedOrigin = publicOrigin(process.env.DASHBOARD_PUBLIC_URL);
const projectId = process.env.DASHBOARD_PROJECT_ID || '5443948697616384';
const number = (value, fallback, min, max) => { const n = Number(value || fallback); if (!Number.isFinite(n) || n < min || n > max) throw new Error('Invalid dashboard configuration'); return n; };
const port = number(process.env.DASHBOARD_PORT, 4243, 1, 65535);
const ttl = number(process.env.DASHBOARD_CACHE_MINUTES, 15, 1, 1440) * 60000;
const dataDir = path.join(__dirname, 'data');
const projectDefinitions = [
  { id: '5443948697616384', name: 'US/CA Web · Melaleuca', market: 'us-ca' },
  { id: '5730256506585088', name: 'MX Web - Melaleuca', market: 'mx' }
];
if (!projectDefinitions.some(p => p.id === projectId)) projectDefinitions.unshift({ id: projectId, name: 'Optimizely project ' + projectId, market: 'all' });
const workspaces = new Map(projectDefinitions.map(project => {
  const legacy = project.id === '5443948697616384';
  const workspace = { project, annotations: {}, annotationQueue: Promise.resolve(), annotationsFile: path.join(dataDir, legacy ? 'annotations.json' : `annotations-${project.id}.json`) };
  const client = createOptimizelyClient({ token: process.env.OPTIMIZELY_TOKEN, projectId: project.id, projectName: project.name, apiBase: process.env.OPTIMIZELY_API_BASE });
  workspace.cache = new SnapshotCache({ file: path.join(dataDir, legacy ? 'snapshot.json' : `snapshot-${project.id}.json`), ttlMs: ttl, load: async () => {
    if (!process.env.OPTIMIZELY_TOKEN) { const e = new Error('Missing token'); e.publicMessage = 'Set OPTIMIZELY_TOKEN in the dashboard .env to enable live updates.'; throw e; }
    return client.snapshot();
  } });
  return [project.id, workspace];
}));
async function initializeWorkspace(workspace) {
  const id = workspace.project.id;
  let initial = {};
  if (id === '5443948697616384') initial = JSON.parse(await fsp.readFile(path.join(__dirname, 'metadata.json'), 'utf8'));
  try { workspace.annotations = { ...initial, ...JSON.parse(await fsp.readFile(workspace.annotationsFile, 'utf8')) }; } catch { workspace.annotations = initial; }
  let seed = null;
  const source = id === projectId && process.env.DASHBOARD_SEED_FILE || path.join(__dirname, '..', 'outputs', 'optimizely-active-20261109', `api-data-${id}.json`);
  try { const raw = JSON.parse(await fsp.readFile(source, 'utf8')); if (String(raw.project_id) === id) seed = summarize(raw); } catch {}
  await workspace.cache.initialize(seed);
  if (workspace.cache.snapshot?.projectId !== id || ![2, 3, 4, 5, 6].includes(workspace.cache.snapshot?.schemaVersion)) workspace.cache.snapshot = seed;
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 20000) throw new Error('Request too large'); } return JSON.parse(text || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'This dashboard is local-only.' });
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: projectDefinitions, defaultProjectId: projectId });
    const workspace = workspaces.get(url.searchParams.get('project_id') || projectId);
    if (!workspace) return json(res, 400, { error: 'Choose an available dashboard project.' });
    const cache = workspace.cache;
    if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      const snapshot = await cache.read();
      return json(res, 200, { ...snapshot, items: snapshot.items.map(item => {
        const annotation = workspace.annotations[item.id] || {};
        return { ...item, annotation, display: resolveFields(item, annotation) };
      }), sync: cache.status() });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (!sameOrigin(req, allowedOrigin)) return json(res, 403, { error: 'Refresh must come from this dashboard.' });
      await body(req); cache.refresh(true).catch(() => {});
      return json(res, 202, cache.status());
    }
    const match = url.pathname.match(/^\/api\/annotations\/(\d{1,20})$/);
    if (match && req.method === 'PATCH') {
      if (!sameOrigin(req, allowedOrigin)) return json(res, 403, { error: 'Edits must come from this dashboard.' });
      if (!cache.snapshot?.items.some(x => x.id === match[1])) return json(res, 404, { error: 'Unknown campaign' });
      const input = await body(req); const next = {};
      input.design ??= workspace.annotations[match[1]]?.design || '';
      for (const [key, limit] of Object.entries({ name: 250, story: 3000, storyUrl: 1000, area: 3000, notes: 5000, owner: 200, plannedEnd: 10, design: 2000 })) {
        if (typeof input[key] !== 'string' || input[key].length > limit) return json(res, 400, { error: 'Invalid ' + key }); next[key] = input[key].trim();
      }
      if (next.design && !designUrl(next.design)) return json(res, 400, { error: 'Use a valid HTTPS design link.' });
      if (next.storyUrl && !/^https:\/\/dev\.azure\.com\/[^\s]+$/i.test(next.storyUrl)) return json(res, 400, { error: 'Use an https://dev.azure.com story link.' });
      if (next.plannedEnd && (!/^\d{4}-\d{2}-\d{2}$/.test(next.plannedEnd) || !Number.isFinite(Date.parse(next.plannedEnd)))) return json(res, 400, { error: 'Invalid planned end date' });
      const save = workspace.annotationQueue.then(async () => {
        const updated = { ...workspace.annotations, [match[1]]: { ...workspace.annotations[match[1]], ...next, updatedAt: new Date().toISOString() } };
        await atomicJson(workspace.annotationsFile, updated); workspace.annotations = updated;
      }); workspace.annotationQueue = save.catch(() => {}); await save;
      return json(res, 200, { saved: true });
    }
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true, projectId: workspace.project.id, ...cache.status() });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/analytics.css': ['analytics.css', 'text/css'] };
    const file = files[url.pathname]; if (!file) return json(res, 404, { error: 'Not found' });
    res.setHeader('Content-Type', file[1] + '; charset=utf-8'); res.end(await fsp.readFile(path.join(__dirname, 'public', file[0])));
  } catch (err) { json(res, url.pathname.startsWith('/api/annotations') ? 400 : 503, { error: err.publicMessage || 'The request could not be completed. Please try again.' }); }
});
server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set DASHBOARD_PORT to another port.` : 'Could not start the local dashboard.'); process.exitCode = 1; });
async function main() {
  await Promise.all([...workspaces.values()].map(initializeWorkspace));
  server.listen(port, '127.0.0.1', () => console.log(`Active campaigns dashboard: http://127.0.0.1:${port}`));
  for (const { cache } of workspaces.values()) cache.refresh(Boolean(cache.snapshot && cache.snapshot.schemaVersion < 6)).catch(() => {});
  const timer = setInterval(() => { for (const { cache } of workspaces.values()) cache.refresh().catch(() => {}); }, 60000); timer.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(() => process.exit(0)); });
}
if (require.main === module) main().catch(() => { console.error('Could not initialize the dashboard. Check configuration and data folder permissions.'); process.exitCode = 1; });
module.exports = { server, main };
