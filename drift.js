// Change-over-time detection for scanned code.
//  1. Per-entity content fingerprints (hashes only, never code) diffed against the previous scan.
//  2. Correlation with Optimizely's project change log: every code change should have a matching history entry
//     (who, when, ui/api). A change with no entry, or a published snippet no entry explains, is flagged.
const crypto = require('node:crypto');
const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
// Which change-log entity type owns each kind of scanned code.
const ENTITY_TYPE = { 'experiment-code': 'experiment', 'widget-config': 'experiment', extension: 'extension', 'audience-code': 'audience', 'page-activation': 'page' };
const SLACK_MS = 2 * 3600000;       // look this far before the previous scan when matching change-log entries
const SNIPPET_MATCH_MS = 10 * 60000; // a snippet publish and its change-log entry should be within minutes of each other
const MAX_EVENTS = 600, MAX_LIST = 300;

// Map "entityType:id" -> { name, status, hashes[] }. Hashes are order-independent per entity.
function fingerprint(sources) {
  const map = {};
  for (const s of sources) {
    const type = ENTITY_TYPE[s.kind]; if (!type) continue;
    const key = `${type}:${s.id}`;
    const entry = map[key] ||= { name: s.name || '', status: s.status || null, hashes: [] };
    if (!entry.status && s.status) entry.status = s.status;
    if (!entry.name && s.name) entry.name = s.name;
    entry.hashes.push(sha([s.kind, s.variation || '', s.field || '', s.code].join('\u0001')));
  }
  for (const entry of Object.values(map)) entry.hashes = [...new Set(entry.hashes)].sort();
  return map;
}
const same = (a, b) => a.hashes.length === b.hashes.length && a.hashes.every((h, i) => h === b.hashes[i]);
function diffFingerprints(prev, next) {
  const added = [], removed = [], changed = [];
  for (const [key, entry] of Object.entries(next)) { if (!prev[key]) added.push(key); else if (!same(prev[key], entry)) changed.push(key); }
  for (const key of Object.keys(prev)) if (!next[key]) removed.push(key);
  return { added, removed, changed };
}
// Reduce change-log records to the few fields we keep; newest first.
function compactChanges(records) {
  return records.filter(r => r?.entity?.type && r.created).map(r => ({
    at: r.created, user: String(r.user?.email || r.user?.display_name || 'Unknown user').slice(0, 120), source: String(r.source || '').slice(0, 20),
    action: String(r.change_type || '').slice(0, 30), entityType: String(r.entity.type), entityId: String(r.entity.id), entityName: String(r.entity.name || '').slice(0, 200)
  })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_EVENTS);
}
function explainSnippet(lastModified, events, windowStart) {
  const t = Date.parse(lastModified);
  if (!Number.isFinite(t)) return { status: 'unknown' };
  if (t < windowStart) return { status: 'outside-window' };
  const near = events.filter(e => Math.abs(Date.parse(e.at) - t) <= SNIPPET_MATCH_MS);
  if (!near.length) return { status: 'unexplained' };
  const by = [...new Map(near.map(e => [e.user + '|' + e.source, { user: e.user, source: e.source, action: e.action, at: e.at }])).values()].slice(0, 3);
  return { status: 'explained', by };
}
// previous: the prior scan report (with .fingerprints and .fetchedAt) or null. history: { events, windowStart } or null when unavailable.
function buildDrift({ sources, previous, history, snippet }) {
  const fingerprints = fingerprint(sources);
  const drift = { baselineAt: null, historyAvailable: Boolean(history), historyWindowStart: history ? new Date(history.windowStart).toISOString() : null, historyTruncated: Boolean(history?.truncated),
    added: [], changed: [], removed: [], counts: { added: 0, changed: 0, removed: 0, unexplained: 0 } };
  const findings = [];
  if (previous?.fingerprints && previous.fetchedAt) {
    drift.baselineAt = previous.fetchedAt;
    const since = Date.parse(previous.fetchedAt) - SLACK_MS;
    const d = diffFingerprints(previous.fingerprints, fingerprints);
    const describe = (key, entry, kind) => {
      const [type, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const by = history && kind !== 'removed' ? history.events.filter(e => e.entityType === type && e.entityId === id && Date.parse(e.at) >= since).slice(0, 5).map(e => ({ user: e.user, source: e.source, action: e.action, at: e.at })) : [];
      // Removals are legitimate deletions far more often than tampering; only added/changed code must be explainable.
      const unexplained = Boolean(history) && kind !== 'removed' && !by.length;
      return { key, type, id, name: entry?.name || '', status: entry?.status || null, by, unexplained };
    };
    drift.added = d.added.map(k => describe(k, fingerprints[k], 'added')).slice(0, MAX_LIST);
    drift.changed = d.changed.map(k => describe(k, fingerprints[k], 'changed')).slice(0, MAX_LIST);
    drift.removed = d.removed.map(k => describe(k, previous.fingerprints[k], 'removed')).slice(0, MAX_LIST);
    drift.counts = { added: d.added.length, changed: d.changed.length, removed: d.removed.length, unexplained: 0 };
    for (const item of [...drift.added, ...drift.changed]) if (item.unexplained) {
      drift.counts.unexplained++;
      findings.push({ rule: 'unexplained-code-change', severity: 'high', label: `Code ${drift.added.includes(item) ? 'added' : 'changed'} since the last scan with no change-history entry`, excerpt: `${item.type} ${item.name} (${item.id})`, kind: ENTITY_TYPE_KIND[item.type] || item.type, entityId: item.id, entityName: item.name, status: item.status, archived: false, variation: null, field: null });
    }
  }
  if (snippet && !snippet.error && history) {
    snippet.explanation = explainSnippet(snippet.lastModified, history.events, history.windowStart);
    if (snippet.explanation.status === 'unexplained') findings.push({ rule: 'unexplained-snippet', severity: 'high', label: 'Published snippet was modified with no matching change-history entry', excerpt: `last modified ${snippet.lastModified}`, kind: 'published-snippet', entityId: '', entityName: 'Published snippet', status: null, archived: false, variation: null, field: null });
  }
  return { drift, fingerprints, findings };
}
const ENTITY_TYPE_KIND = { experiment: 'experiment-code', extension: 'extension', audience: 'audience-code', page: 'page-activation' };
module.exports = { fingerprint, diffFingerprints, compactChanges, explainSnippet, buildDrift, ENTITY_TYPE };
