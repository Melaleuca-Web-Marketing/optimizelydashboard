const { summarize } = require('./model');
function createOptimizelyClient({ token, projectId, projectName = 'US/CA Web · Melaleuca', apiBase = 'https://api.optimizely.com/v2', fetchImpl = fetch, spacingMs = 500 }) {
  const base = new URL(apiBase.replace(/\/$/, '') + '/');
  if (base.protocol !== 'https:' || base.hostname !== 'api.optimizely.com') throw new Error('Optimizely API base must use https://api.optimizely.com.');
  let queue = Promise.resolve(); let calls = 0;
  async function get(url) {
    const target = new URL(url, base);
    if (target.origin !== base.origin) throw new Error('Unexpected pagination host');
    const turn = queue.then(() => new Promise(r => setTimeout(r, spacingMs)));
    queue = turn.catch(() => {}); await turn;
    calls++;
    let r;
    try { r = await fetchImpl(target, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: AbortSignal.timeout(45000), redirect: 'error' }); }
    catch (err) {
      if (/CERT|ISSUER|SELF_SIGNED/.test(err.cause?.code || '')) err.publicMessage = 'The server could not verify the Optimizely connection certificate. Use Node 22.19+ with Windows trusted certificates, or configure NODE_EXTRA_CA_CERTS.';
      throw err;
    }
    if (!r.ok) {
      const err = new Error('Optimizely HTTP ' + r.status);
      err.publicMessage = r.status === 429 ? 'Optimizely rate limit reached. Waiting before the next sync.' : r.status === 401 || r.status === 403 ? 'Optimizely credentials need attention. Check the server token and project access.' : 'Optimizely is unavailable (HTTP ' + r.status + '). Showing the last successful snapshot.';
      const retry = r.headers.get('retry-after');
      err.retryAfterMs = retry ? Math.min(86400000, Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now())) : 0;
      throw err;
    }
    return { data: await r.json(), headers: r.headers };
  }
  async function list(resource) {
    let url = new URL(resource, base); url.searchParams.set('project_id', projectId); url.searchParams.set('per_page', '100'); url.searchParams.set('page', '1');
    const result = [], seen = new Set();
    while (url) {
      if (seen.has(url.href) || seen.size >= 200) throw new Error('Invalid Optimizely pagination');
      seen.add(url.href);
      const { data, headers } = await get(url);
      const items = Array.isArray(data) ? data : data?.results || data?.items;
      if (!Array.isArray(items)) throw new Error('Unexpected Optimizely list shape');
      result.push(...items);
      const next = headers.get('link')?.match(/<([^>]+)>\s*;\s*rel="next"/i);
      if (next) { const candidate = new URL(next[1], base); if (candidate.origin !== base.origin) throw new Error('Unexpected pagination host'); url = candidate; }
      else if (items.length === 100) { url = new URL(url); url.searchParams.set('page', String(Number(url.searchParams.get('page')) + 1)); }
      else url = null;
    }
    return result;
  }
  return { async snapshot() {
    const before = calls;
    const [campaigns, experiments, pages, audiences] = await Promise.all(['campaigns', 'experiments', 'pages', 'audiences'].map(list));
    const snapshot = summarize({ project_id: projectId, project: { name: projectName }, retrieved_at: new Date().toISOString(), campaigns, experiments, pages, audiences });
    return { ...snapshot, apiCalls: calls - before };
  } };
}
module.exports = { createOptimizelyClient };
