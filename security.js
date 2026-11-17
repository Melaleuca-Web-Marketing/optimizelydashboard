// Scans customer-authored Optimizely code for indicators of the Nov 2026 Optimizely Web supply-chain compromise
// and for generally risky patterns. Findings never include full source, only short excerpts.
const IOC_DOMAINS = ['1688360.cc'];
const RULES = [
  { id: 'ioc-domain', severity: 'critical', label: 'Known malicious domain', test: new RegExp(IOC_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|'), 'i') },
  { id: 'atob', severity: 'high', label: 'Base64 decode (atob)', test: /\batob\s*\(/ },
  { id: 'eval', severity: 'high', label: 'Dynamic code execution (eval / new Function)', test: /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/ },
  { id: 'obfuscation', severity: 'high', label: 'Obfuscation (fromCharCode / hex or unicode escapes / unescape)', test: /String\s*\.\s*fromCharCode|(?:\\x[0-9a-f]{2}){4,}|(?:\\u[0-9a-f]{4}){4,}|\bunescape\s*\(/i },
  { id: 'script-injection', severity: 'high', label: 'Script injection (createElement script / document.write)', test: /createElement\s*\(\s*['"`]script['"`]\s*\)|document\s*\.\s*write(?:ln)?\s*\(|\.insertAdjacentHTML\s*\(\s*[^)]*<script/i },
  { id: 'exfil-channel', severity: 'medium', label: 'Network call (fetch / XHR / beacon / WebSocket)', test: /\bfetch\s*\(|XMLHttpRequest|sendBeacon\s*\(|new\s+WebSocket\s*\(|new\s+EventSource\s*\(/ },
  { id: 'cookie-access', severity: 'medium', label: 'Cookie access', test: /document\s*\.\s*cookie|cookieStore/ },
  { id: 'sensitive-field', severity: 'medium', label: 'Payment or password field handling', test: /card[\s_-]?number|cc-?num|cvv|cvc|type\s*=\s*['"]?password|input\[type=.?password/i },
  { id: 'external-url', severity: 'low', label: 'External URL', test: null }
];
const URL_RE = /(?:https?:)?\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[^\s'"`)<>]*/gi;
// Hosts that are expected in Melaleuca / Optimizely code. Extend as needed; anything else is reported as low-severity.
const DEFAULT_ALLOWED_HOSTS = [/(^|\.)melaleuca\.(com|net)$/i, /(^|\.)optimizely\.com$/i, /(^|\.)googletagmanager\.com$/i, /(^|\.)google-analytics\.com$/i, /(^|\.)w3\.org$/i];

function hostOf(url) { try { return new URL(url.startsWith('//') ? 'https:' + url : url).hostname; } catch { return ''; } }
function excerpt(text, index, length = 100) {
  const start = Math.max(0, index - 30);
  return text.slice(start, start + length).replace(/\s+/g, ' ').trim();
}
function scanCode(text, { allowedHosts = DEFAULT_ALLOWED_HOSTS } = {}) {
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
  const longest = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
  if (longest > 2000) findings.push({ rule: 'long-line', severity: 'medium', label: 'Very long line (' + longest + ' chars): possible minified or packed code', excerpt: '' });
  return findings;
}

// Collect every code-bearing string in a project's raw API data with a stable pointer back to where it lives.
function collectSources({ project, experiments = [], pages = [], extensions = [] }) {
  const sources = [];
  if (typeof project?.project_javascript === 'string' && project.project_javascript) sources.push({ kind: 'project-javascript', id: String(project.id || ''), name: 'Project JavaScript', code: project.project_javascript });
  for (const e of experiments) for (const v of e.variations || []) for (const a of v.actions || []) for (const c of a.changes || []) {
    for (const field of ['value', 'src', 'css', 'dependencies']) {
      const raw = c[field]; const text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
      // Only custom code, CSS and injected attribute/html values can run in visitors' browsers.
      if (text && (c.type === 'custom_code' || c.type === 'custom_css' || field !== 'value' || /<script|javascript:|on\w+\s*=/i.test(text))) sources.push({ kind: 'experiment-code', id: String(e.id), name: e.name, status: e.status, archived: Boolean(e.archived), variation: v.name, changeType: c.type || '', field, code: text });
    }
  }
  for (const p of pages) if (typeof p.activation_code === 'string' && p.activation_code) sources.push({ kind: 'page-activation', id: String(p.id), name: p.name, code: p.activation_code });
  for (const x of extensions) {
    const text = [x.implementation, x.edit_url ? '' : '', x.code].filter(v => typeof v === 'string').join('\n');
    if (text) sources.push({ kind: 'extension', id: String(x.id || ''), name: x.name || x.id, code: text });
  }
  return sources;
}
const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
function scanProject(raw, options) {
  const findings = [];
  const sources = collectSources(raw);
  for (const source of sources) for (const f of scanCode(source.code, options)) {
    findings.push({ ...f, kind: source.kind, entityId: source.id, entityName: source.name || '', status: source.status || null, archived: Boolean(source.archived), variation: source.variation || null, field: source.field || null });
  }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.entityName.localeCompare(b.entityName));
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return { scannedSources: sources.length, scannedExperiments: raw.experiments?.length || 0, scannedPages: raw.pages?.length || 0, scannedExtensions: raw.extensions?.length || 0, counts, findings };
}
module.exports = { scanCode, scanProject, collectSources, IOC_DOMAINS };
