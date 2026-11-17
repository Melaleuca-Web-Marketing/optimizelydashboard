#!/usr/bin/env node
// One-off CLI: scan every configured project's Optimizely code and print a report. Read-only.
// Usage: node scripts/scan-security.js [--no-save] [projectId ...]   (token from OPTIMIZELY_TOKEN, ./.env or ../.env)
// Reads and updates the same data/security-<projectId>.json baseline the dashboard uses, so repeated runs report what changed.
// Exit code 1 if any critical finding or any code change/snippet publish has no matching Optimizely change-history entry.
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
const { atomicJson } = require('../cache');
(async () => {
  if (!process.env.OPTIMIZELY_TOKEN) { console.error('OPTIMIZELY_TOKEN is not set.'); process.exit(2); }
  const args = process.argv.slice(2), save = !args.includes('--no-save'), wanted = args.filter(a => !a.startsWith('--'));
  let flagged = 0;
  for (const project of SECURITY_PROJECTS.filter(p => !wanted.length || wanted.includes(p.id))) {
    const client = createOptimizelyClient({ token: process.env.OPTIMIZELY_TOKEN, projectId: project.id, projectName: project.name });
    const file = path.join(__dirname, '..', 'data', `security-${project.id}.json`);
    let previous = null; try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const r = await runSecurityScan(client, project, previous);
    if (save) await atomicJson(file, r);
    flagged += r.counts.critical + r.findings.filter(f => f.rule === 'unexplained-code-change' || f.rule === 'unexplained-snippet').length;
    console.log(`\n=== ${project.name} (${project.id}) ===`);
    console.log(`Scanned ${r.scannedSources} code sources from ${r.scannedExperiments} experiments, ${r.scannedPages} pages, ${r.scannedExtensions} extensions.`);
    const sn = r.snippet;
    console.log(sn.error ? `Published snippet: ${sn.error}` : `Published snippet (includes Project JavaScript): ${(sn.bytes / 1048576).toFixed(2)} MB, sha256 ${sn.sha256.slice(0, 16)}, last-modified ${sn.lastModified}`);
    const dr = r.drift;
    console.log(!dr.baselineAt ? 'Changes: no baseline yet, this scan' + (save ? ' becomes' : ' would become') + ' the baseline.' : `Changes since ${dr.baselineAt}: ${dr.counts.added} added, ${dr.counts.changed} changed, ${dr.counts.removed} removed, ${dr.counts.unexplained} with no change-history entry.`);
    if (!dr.historyAvailable) console.log(`Change history unavailable: ${dr.historyError || 'unknown'}`);
    if (sn.explanation) console.log(`Snippet vs change history: ${sn.explanation.status}${sn.explanation.by ? ' (' + sn.explanation.by.map(b => `${b.user} via ${b.source}`).join(', ') + ')' : ''}`);
    for (const [label, list] of [['CHANGED', dr.changed], ['ADDED', dr.added], ['REMOVED', dr.removed]]) for (const i of list) console.log(`  ${label} ${i.type} ${i.name} (${i.id}) ${i.by.length ? 'by ' + i.by.map(b => `${b.user} via ${b.source}`).join(', ') : i.unexplained ? '*** NO CHANGE-HISTORY ENTRY ***' : ''}`);
    console.log(`Critical ${r.counts.critical} · High ${r.counts.high} · Medium ${r.counts.medium} · Low ${r.counts.low}`);
    for (const f of r.findings) console.log(`[${f.severity.toUpperCase()}] ${f.label} | ${f.kind} ${f.entityName} (${f.entityId})${f.variation ? ' / ' + f.variation : ''}${f.status ? ' [' + f.status + ']' : ''}${f.archived ? ' [archived]' : ''} | ${f.excerpt}`);
  }
  process.exit(flagged ? 1 : 0);
})().catch(err => { console.error('Scan failed:', err.publicMessage || err.message); process.exit(2); });
