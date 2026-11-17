// Scans customer-authored Optimizely code for indicators of the Nov 2026 Optimizely Web supply-chain compromise
// and for generally risky patterns. Findings never include full source, only short excerpts.
const IOC_DOMAINS = ['1688360.cc'];
const RULES = [
  { id: 'ioc-domain', severity: 'critical', label: 'Known malicious domain', test: new RegExp(IOC_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|'), 'i') },
  { id: 'atob', severity: 'high', label: 'Base64 decode (atob)', test: /\batob\s*\(/ },
  { id: 'eval', severity: 'high', label: 'Dynamic code execution (eval / new Function)', test: /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/ },
  { id: 'obfuscation', severity: 'high', label: 'Obfuscation (fromCharCode / hex or unicode escapes / unescape)', test: /String\s*\.\s*fromCharCode|(?:\\x[2-7][0-9a-f]){4,}|(?:\\u00[2-7][0-9a-f]){4,}|\bunescape\s*\(/i },
  { id: 'script-injection', severity: 'high', label: 'Script injection (createElement script / document.write)', test: /createElement\s*\(\s*['"`]script['"`]\s*\)|document\s*\.\s*write(?:ln)?\s*\(|\.insertAdjacentHTML\s*\(\s*[^)]*<script/i },
  { id: 'exfil-channel', severity: 'medium', label: 'Network call (fetch / XHR / beacon / WebSocket)', test: /\bfetch\s*\(|XMLHttpRequest|sendBeacon\s*\(|new\s+WebSocket\s*\(|new\s+EventSource\s*\(/ },
  { id: 'cookie-access', severity: 'medium', label: 'Cookie access', test: /document\s*\.\s*cookie|cookieStore/ },
  { id: 'sensitive-field', severity: 'medium', label: 'Payment or password field handling', test: /card[\s_-]?number|cc-?num|cvv|cvc|type\s*=\s*['"]?password|input\[type=.?password/i },
  { id: 'external-url', severity: 'low', label: 'External URL', test: null }
];
const URL_RE = /(?:https?:\/\/|(?<=['"`(=])\/\/)(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w.(-])(?::\d+)?[^\s'"`)<>]*/gi;
// Hosts that are expected in Melaleuca / Optimizely code. Extend as needed; anything else is reported as low-severity.
const DEFAULT_ALLOWED_HOSTS = [/(^|\.)melaleuca\.(com|net)$/i, /(^|\.)optimizely\.com$/i, /(^|\.)googletagmanager\.com$/i, /(^|\.)google-analytics\.com$/i, /(^|\.)w3\.org$/i];

function hostOf(url) { try { return new URL(url.startsWith('//') ? 'https:' + url : url).hostname; } catch { return ''; } }
function excerpt(text, index, length = 100) {
  const start = Math.max(0, index - 30);
  return text.slice(start, start + length).replace(/\s+/g, ' ').trim();
}
function scanCode(text, { allowedHosts = DEFAULT_ALLOWED_HOSTS, longLines = true } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const findings = [];
  for (const rule of RULES) {
    if (rule.test) {
      const m = rule.test.exec(text);
      if (m) findings.push({ rule: rule.id, severity: rule.severity, label: rule.label, excerpt: excerpt(text, m.index) });
    }
  }
  const hosts = new Map();
  for (const m of text.matchAll(URL_RE)) { const host = hostOf(m[0]); if (host && !allowedHosts.some(re => re.test(host)) && !hosts.has(host)) hosts.set(host, excerpt(text, m.index)); }
  for (const [host, ex] of hosts) findings.push({ rule: 'external-url', severity: IOC_DOMAINS.some(d => host.endsWith(d)) ? 'critical' : 'low', label: 'External URL: ' + host, excerpt: ex });
  const longest = !longLines ? 0 : text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
  if (longest > 2000) findings.push({ rule: 'long-line', severity: 'medium', label: 'Very long line (' + longest + ' chars): possible minified or packed code', excerpt: '' });
  return findings;
}

// The published snippet bundles Optimizely's own runtime (eval, fetch, cookies, 300KB+ lines), so the full rule set
// is pure noise there. Snippet mode keeps only high-signal rules: the known IOC, atob, and unexpected hosts.
const SNIPPET_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w.(-])(?::\d+)?[^\s'"`)<>\\]*/gi;
function scanSnippet(text, { allowedHosts = DEFAULT_ALLOWED_HOSTS } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const findings = [];
  for (const rule of RULES.filter(r => r.id === 'ioc-domain' || r.id === 'atob')) {
    const m = rule.test.exec(text);
    if (m) findings.push({ rule: rule.id, severity: rule.severity, label: rule.label, excerpt: excerpt(text, m.index) });
  }
  const hosts = new Map();
  for (const m of text.matchAll(SNIPPET_URL_RE)) { const host = hostOf(m[0]); if (host && !allowedHosts.some(re => re.test(host)) && !hosts.has(host)) hosts.set(host, excerpt(text, m.index)); }
  for (const [host, ex] of hosts) findings.push({ rule: 'external-url', severity: IOC_DOMAINS.some(d => host.endsWith(d)) ? 'critical' : 'low', label: 'External URL: ' + host, excerpt: ex });
  return findings;
}
function snippetFindings(projectId, text, options) {
  return scanSnippet(text, options).map(f => ({ ...f, kind: 'published-snippet', entityId: String(projectId), entityName: 'Published snippet', status: null, archived: false, variation: null, field: null }));
}
const ORDER_SEV = { critical: 0, high: 1, medium: 2, low: 3 };
// Merge extra findings (e.g. from the snippet) into an existing scanProject result, keeping order and counts consistent.
function mergeFindings(result, extra) {
  const findings = [...result.findings, ...extra].sort((a, b) => ORDER_SEV[a.severity] - ORDER_SEV[b.severity] || a.entityName.localeCompare(b.entityName));
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return { ...result, findings, counts };
}

// Collect every code-bearing string in a project's raw API data with a stable pointer back to where it lives.
// Audience conditions can be nested arrays or JSON strings; yield every leaf condition object.
function conditionLeaves(value, out = []) {
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? conditionLeaves(parsed, out) : out; } catch { return out; } }
  if (Array.isArray(value)) value.forEach(v => conditionLeaves(v, out));
  else if (value && typeof value === 'object') { if (value.type) out.push(value); for (const v of Object.values(value)) if (v && typeof v === 'object') conditionLeaves(v, out); }
  return out;
}
function collectSources({ project, experiments = [], pages = [], extensions = [], audiences = [] }) {
  const sources = [];
  // "code" audience conditions are custom JavaScript evaluated in every visitor's browser during targeting.
  for (const a of audiences) for (const leaf of conditionLeaves(a.conditions)) {
    if (leaf.type === 'code' && typeof leaf.value === 'string' && leaf.value) sources.push({ kind: 'audience-code', id: String(a.id), name: a.name, archived: Boolean(a.archived), code: leaf.value });
  }
  if (typeof project?.project_javascript === 'string' && project.project_javascript) sources.push({ kind: 'project-javascript', id: String(project.id || ''), name: 'Project JavaScript', code: project.project_javascript });
  for (const e of experiments) for (const v of e.variations || []) for (const a of v.actions || []) for (const c of a.changes || []) {
    for (const field of ['value', 'src', 'css', 'dependencies']) {
      const raw = c[field]; let text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
      if (text === '[]' || text === '{}') text = '';
      // Only custom code, CSS and injected attribute/html values can run in visitors' browsers.
      if (text && (c.type === 'custom_code' || c.type === 'custom_css' || field !== 'value' || /<script|javascript:|on\w+\s*=/i.test(text))) sources.push({ kind: 'experiment-code', id: String(e.id), name: e.name, status: e.status, archived: Boolean(e.archived), variation: v.name, changeType: c.type || '', field, code: text });
    }
  }
  // Widget settings (copy, URLs, positions) are rendered by extension templates, so a poisoned value can inject markup.
  for (const e of experiments) for (const v of e.variations || []) for (const a of v.actions || []) for (const c of a.changes || []) {
    if (c.type === 'widget' && c.config && typeof c.config === 'object' && Object.keys(c.config).length) sources.push({ kind: 'widget-config', id: String(e.id), name: e.name, status: e.status, archived: Boolean(e.archived), variation: v.name, field: 'config:' + (c.name || c.extension_id || ''), code: JSON.stringify(c.config) });
  }
  for (const p of pages) if (typeof p.activation_code === 'string' && p.activation_code) sources.push({ kind: 'page-activation', id: String(p.id), name: p.name, code: p.activation_code });
  // Extension (widget template) code lives in implementation.{html,css,apply_js,undo_js,reset_js}; scan each part separately
  // so findings say which one. Default field values can also carry markup.
  for (const x of extensions) {
    const base = { kind: 'extension', id: String(x.id || ''), name: x.name || String(x.id || ''), status: x.enabled === false ? 'disabled' : 'enabled', archived: Boolean(x.archived) };
    const impl = x.implementation;
    const parts = typeof impl === 'string' ? { implementation: impl } : impl && typeof impl === 'object' ? impl : {};
    for (const [field, value] of Object.entries(parts)) { const text = typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : ''; if (text) sources.push({ ...base, field, code: text }); }
    if (typeof x.code === 'string' && x.code) sources.push({ ...base, field: 'code', code: x.code });
    if (Array.isArray(x.fields) && x.fields.length) sources.push({ ...base, field: 'fields', code: JSON.stringify(x.fields) });
  }
  return sources;
}
const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
function scanProject(raw, options) {
  const findings = [];
  const sources = collectSources(raw);
  // JSON we stringified ourselves (widget settings, extension fields) is always one long line, so skip that check there.
  for (const source of sources) for (const f of scanCode(source.code, { ...options, longLines: !(source.kind === 'widget-config' || source.field === 'fields') })) {
    findings.push({ ...f, kind: source.kind, entityId: source.id, entityName: source.name || '', status: source.status || null, archived: Boolean(source.archived), variation: source.variation || null, field: source.field || null });
  }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.entityName.localeCompare(b.entityName));
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return { scannedSources: sources.length, scannedExperiments: raw.experiments?.length || 0, scannedPages: raw.pages?.length || 0, scannedExtensions: raw.extensions?.length || 0, scannedAudiences: raw.audiences?.length || 0, counts, findings };
}
// Full scan for one project: API-visible code plus the published snippet. A snippet failure never hides the API results.
const { buildDrift, compactChanges } = require('./drift');
async function runSecurityScan(client, project, previous = null, { historyDays = 45, now = Date.now } = {}) {
  const raw = await client.securitySources();
  let result = scanProject(raw);
  // Change log is best-effort: if it is unavailable we skip the "unexplained" checks rather than raise false alarms.
  let history = null, historyError = null;
  if (typeof client.projectChanges === 'function') {
    try {
      const end = now(), start = end - historyDays * 86400000;
      const r = await client.projectChanges({ start, end });
      history = { events: compactChanges(r.records), windowStart: start, truncated: r.truncated };
    } catch (err) { historyError = err.publicMessage || 'The Optimizely change history could not be loaded.'; }
  }
  let snippet = null;
  try {
    const s = await client.snippet();
    const prior = previous?.snippet;
    snippet = { bytes: s.bytes, sha256: s.sha256, lastModified: s.lastModified, etag: s.etag, changedSinceLastScan: prior?.sha256 ? prior.sha256 !== s.sha256 : null, previousSha256: prior?.sha256 || null, previousScannedAt: previous?.fetchedAt || null };
    result = mergeFindings(result, snippetFindings(project.id, s.text));
  } catch (err) { snippet = { error: err.publicMessage || 'The published snippet could not be scanned.' }; }
  const { drift, fingerprints, findings: driftFindings } = buildDrift({ sources: collectSources(raw), previous, history, snippet });
  drift.historyError = historyError;
  result = mergeFindings(result, driftFindings);
  return { schemaVersion: 3, projectId: project.id, projectName: project.name, fetchedAt: new Date().toISOString(), apiCalls: raw.apiCalls, snippet, drift, fingerprints, recentChanges: history ? history.events : [], ...result, items: result.findings };
}
module.exports = { runSecurityScan, scanCode, scanSnippet, snippetFindings, mergeFindings, scanProject, collectSources, IOC_DOMAINS };
