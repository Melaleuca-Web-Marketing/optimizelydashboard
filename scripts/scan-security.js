#!/usr/bin/env node
// One-off CLI: scan every configured project's Optimizely code and print a report. Read-only.
// Usage: node scripts/scan-security.js [projectId ...]   (token from OPTIMIZELY_TOKEN, ./.env or ../.env)
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
if (process.platform === 'win32' && tls.setDefaultCACertificates && tls.getCACertificates) tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
for (const file of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env')]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const { SECURITY_PROJECTS } = require('../projects');
const { createOptimizelyClient } = require('../optimizely');
const { runSecurityScan } = require('../security');
(async () => {
  if (!process.env.OPTIMIZELY_TOKEN) { console.error('OPTIMIZELY_TOKEN is not set.'); process.exit(2); }
  const wanted = process.argv.slice(2);
  let critical = 0;
  for (const project of SECURITY_PROJECTS.filter(p => !wanted.length || wanted.includes(p.id))) {
    const client = createOptimizelyClient({ token: process.env.OPTIMIZELY_TOKEN, projectId: project.id, projectName: project.name });
    const r = await runSecurityScan(client, project);
    critical += r.counts.critical;
    console.log(`\n=== ${project.name} (${project.id}) ===`);
    console.log(`Scanned ${r.scannedSources} code sources from ${r.scannedExperiments} experiments, ${r.scannedPages} pages, ${r.scannedExtensions} extensions.`);
    const sn = r.snippet;
    console.log(sn.error ? `Published snippet: ${sn.error}` : `Published snippet (includes Project JavaScript): ${(sn.bytes / 1048576).toFixed(2)} MB, sha256 ${sn.sha256.slice(0, 16)}, last-modified ${sn.lastModified}`);
    console.log(`Critical ${r.counts.critical} · High ${r.counts.high} · Medium ${r.counts.medium} · Low ${r.counts.low}`);
    for (const f of r.findings) console.log(`[${f.severity.toUpperCase()}] ${f.label} | ${f.kind} ${f.entityName} (${f.entityId})${f.variation ? ' / ' + f.variation : ''}${f.status ? ' [' + f.status + ']' : ''}${f.archived ? ' [archived]' : ''} | ${f.excerpt}`);
  }
  process.exit(critical ? 1 : 0);
})().catch(err => { console.error('Scan failed:', err.publicMessage || err.message); process.exit(2); });
