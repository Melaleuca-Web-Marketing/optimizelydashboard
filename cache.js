const fs = require('node:fs/promises');
const path = require('node:path');
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp'; await fs.writeFile(tmp, JSON.stringify(value, null, 2)); await fs.rename(tmp, file);
}
class SnapshotCache {
  constructor({ load, file, ttlMs = 900000, cooldownMs = 60000, now = Date.now }) {
    Object.assign(this, { load, file, ttlMs, cooldownMs, now });
    this.snapshot = null; this.pending = null; this.lastError = null; this.retryAt = 0; this.lastAttempt = 0; this.failures = 0;
  }
  async initialize(seed) {
    try { this.snapshot = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { this.snapshot = seed || null; }
    if (!Array.isArray(this.snapshot?.items) || !Number.isFinite(Date.parse(this.snapshot?.fetchedAt))) this.snapshot = null;
  }
  fresh() { return this.snapshot && this.now() - Date.parse(this.snapshot.fetchedAt) < this.ttlMs; }
  async refresh(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.fresh()) return this.snapshot;
    if (this.now() < this.retryAt) { if (this.snapshot) return this.snapshot; throw new Error('Sync is cooling down; try again shortly.'); }
    this.lastAttempt = this.now();
    this.pending = (async () => {
      try {
        const next = await this.load();
        if (!Array.isArray(next?.items) || !Number.isFinite(Date.parse(next.fetchedAt))) throw new Error('Invalid snapshot');
        // A failed persistence must not replace the known good snapshot.
        await atomicJson(this.file, next);
        this.snapshot = next; this.lastError = null; this.failures = 0; this.retryAt = this.now() + this.cooldownMs;
        return next;
      } catch (err) {
        this.lastError = err.publicMessage || 'Optimizely sync failed. The last successful snapshot is still available.';
        this.failures++;
        const backoff = Math.min(15 * 60000, this.cooldownMs * 2 ** Math.min(this.failures - 1, 10));
        this.retryAt = this.now() + Math.max(backoff, err.retryAfterMs || 0);
        if (!this.snapshot) throw err;
        return this.snapshot;
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
  async read() {
    if (!this.snapshot) await this.refresh();
    else if (!this.fresh() && !this.pending && this.now() >= this.retryAt) this.refresh().catch(() => {});
    return this.snapshot;
  }
  status() {
    return { fetchedAt: this.snapshot?.fetchedAt || null, stale: !this.fresh(), syncing: Boolean(this.pending), error: this.lastError, cacheMinutes: this.ttlMs / 60000,
      nextSyncAt: new Date(Math.max((Date.parse(this.snapshot?.fetchedAt) || 0) + this.ttlMs, this.retryAt)).toISOString(), retryAt: this.retryAt > this.now() ? new Date(this.retryAt).toISOString() : null };
  }
}
module.exports = { SnapshotCache, atomicJson };
