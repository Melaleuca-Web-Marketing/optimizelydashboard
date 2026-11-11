const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson } = require('./cache');
const DAY = 86400000;
const text = (value, max = 4000) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '').slice(0, max);
function normalizeChanges(rows, projectId, entities) {
  const allowed = new Set(entities.map(e => `${e.type}:${e.id}`));
  return rows.filter(r => /^\d+$/.test(String(r.id)) && String(r.project_id) === projectId && allowed.has(`${r.entity?.type}:${r.entity?.id}`)).map(r => ({
    id: String(r.id), created: r.created, action: text(r.change_type, 80), summary: text(r.summary, 1000), source: text(r.source, 80),
    actor: text(r.user?.display_name || [r.user?.first_name, r.user?.last_name].filter(Boolean).join(' ') || r.user?.email || 'Unknown user', 200),
    entity: { id: String(r.entity.id), type: r.entity.type, name: text(r.entity.name, 250), deleted: Boolean(r.entity.is_deleted) },
    changes: (Array.isArray(r.changes) ? r.changes : []).slice(0, 30).map(c => {
      const field = { property: text(c.property, 200), description: text(c.description, 500) };
      for (const key of ['before', 'after']) {
        field[key] = Object.hasOwn(c, key) ? text(c[key]) : null;
        field[key + 'Truncated'] = Object.hasOwn(c, key) && text(c[key], 4001).length > 4000;
      }
      return field;
    }), extraChanges: Math.max(0, (r.changes?.length || 0) - 30)
  }));
}

class HistoryStore {
  constructor({ directory, projectId, loadPage, now = Date.now, ttlMs = DAY, cooldownMs = 60000 }) {
    Object.assign(this, { directory, projectId, loadPage, now, ttlMs, cooldownMs });
    this.entries = new Map(); this.pending = new Map();
  }
  async read(item, { action = 'read', cursor } = {}) {
    if (this.pending.has(item.id)) return this.pending.get(item.id);
    const request = this.run(item, action, cursor).finally(() => this.pending.delete(item.id));
    this.pending.set(item.id, request);return request;
  }
  async run(item, action, cursor) {
    if (!/^\d+$/.test(item.id)) throw new Error('Invalid campaign ID');
    const file = path.join(this.directory, `${this.projectId}-${item.id}.json`);
    if (!this.entries.has(item.id)) {
      let saved = null;
      try { const candidate = JSON.parse(await fs.readFile(file, 'utf8')); if (candidate.version === 1 && candidate.projectId === this.projectId && candidate.campaignId === item.id) saved = candidate; } catch {}
      this.entries.set(item.id, saved);
    }
    let saved = this.entries.get(item.id);
    const entities = item.historyEntities;
    if (!Array.isArray(entities) || !entities.length) return { available: false, error: 'History is available after the next successful campaign sync.', records: [] };
    if (entities.length > 500) return { available: false, error: 'This campaign has too many related entities for a bounded history request. Use Optimizely to inspect its full history.', records: [] };
    const scope = JSON.stringify(entities.map(e => [e.type, e.id]).sort());
    const current = saved && saved.scope === scope;
    const fresh = current && this.now() - Date.parse(saved.fetchedAt) < this.ttlMs;
    if (action === 'read' && fresh || action === 'older' && current && cursor !== saved.cursor) return this.result(saved);
    if (current && this.now() < (saved.retryAt || 0) && (action !== 'older' || saved.error)) return this.result(saved);
    // A scope change must also respect the cooldown; keep the last known coverage visible.
    if (saved && this.now() < (saved.retryAt || 0) && (action !== 'older' || saved.error)) return this.result(saved);
    const latest = !fresh || action === 'refresh';
    const floor = Number.isFinite(Date.parse(item.historyStart)) ? Date.parse(item.historyStart) : 0;
    const end = latest ? this.now() : saved.end;
    let start = latest ? Math.max(floor, end - 30 * DAY) : saved.start;
    let streams;
    let records = latest ? [] : saved.records;
    if (!latest && !saved.hasMore) return this.result(saved);
    if (!latest && saved.streams.some(s => s.hasMore)) {
      streams = saved.streams.filter(s => s.hasMore).map(s => ({ ...s, page: s.page + 1 }));
    } else {
      const windowEnd = latest ? end : saved.start;
      start = Math.max(floor, windowEnd - 30 * DAY);
      streams = [];
      for (let i = 0; i < entities.length; i += 50) streams.push({ entities: entities.slice(i, i + 50), page: 1, start, end: windowEnd });
    }
    try {
      const loaded = [];
      for (const stream of streams) {
        const response = await this.loadPage(stream);
        loaded.push({ ...stream, hasMore: response.hasMore });
        records = records.concat(normalizeChanges(response.records, this.projectId, stream.entities));
      }
      const merged = [...new Map(records.map(r => [r.id, r])).values()].sort((a,b) => Date.parse(b.created) - Date.parse(a.created));
      const limitReached = merged.length >= 2000;
      const next = { version: 1, projectId: this.projectId, campaignId: item.id, scope, records: merged.slice(0, 2000), streams: loaded,
        fetchedAt: latest ? new Date(this.now()).toISOString() : saved.fetchedAt, updatedAt: new Date(this.now()).toISOString(), start, end,
        hasMore: !limitReached && (loaded.some(s => s.hasMore) || start > floor), limitReached, cursor: String(Number(saved?.cursor || 0) + 1),
        retryAt: this.now() + this.cooldownMs, error: null, failures: 0, lastCalls: streams.length, entityCount: entities.length };
      await atomicJson(file, next);this.entries.set(item.id, next);return this.result(next);
    } catch (err) {
      const failures = (saved?.failures || 0) + 1;
      const fallback = { ...(saved || {}), version: 1, projectId: this.projectId, campaignId: item.id, failures,
        retryAt: this.now() + Math.max(Math.min(900000, this.cooldownMs * 2 ** Math.min(failures - 1, 10)), err.retryAfterMs || 0), error: err.publicMessage || 'History could not be loaded. Saved history is shown when available.' };
      this.entries.set(item.id, fallback);
      try { await atomicJson(file, fallback); } catch {}
      return this.result(fallback);
    }
  }
  result(saved) {
    return { available: true, records: saved.records || [], fetchedAt: saved.fetchedAt || null, updatedAt: saved.updatedAt || null,
      start: saved.start ? new Date(saved.start).toISOString() : null, end: saved.end ? new Date(saved.end).toISOString() : null,
      stale: !saved.fetchedAt || this.now() - Date.parse(saved.fetchedAt) >= this.ttlMs, error: saved.error || null,
      retryAt: saved.retryAt > this.now() ? new Date(saved.retryAt).toISOString() : null, hasMore: Boolean(saved.hasMore), moreInPeriod: Boolean(saved.streams?.some(s => s.hasMore)), cursor: saved.cursor || '',
      limitReached: Boolean(saved.limitReached), lastCalls: saved.lastCalls || 0, entityCount: saved.entityCount || 0, cacheHours: this.ttlMs / DAY * 24 };
  }
}
module.exports = { HistoryStore, normalizeChanges };
