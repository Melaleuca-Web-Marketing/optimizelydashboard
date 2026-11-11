const { summarize } = require('./model');
function createOptimizelyClient({ token, projectId, projectName = 'US/CA Web · Melaleuca', apiBase = 'https://api.optimizely.com/v2', fetchImpl = fetch, spacingMs = 500 }) {
  const base = new URL(apiBase.replace(/\/$/, '') + '/');
  if (base.protocol !== 'https:' || base.hostname !== 'api.optimizely.com') throw new Error('Optimizely API base must use https://api.optimizely.com.');
  let queue = Promise.resolve(); let calls = 0; let blockedUntil = 0;
  async function get(url) {
    const target = new URL(url, base);
    if (target.origin !== base.origin) throw new Error('Unexpected pagination host');
    const turn = queue.then(() => new Promise(r => setTimeout(r, spacingMs)));
    queue = turn.catch(() => {}); await turn;
    if (Date.now() < blockedUntil) {
      const err = new Error('Rate limit cooldown');err.publicMessage = 'Optimizely rate limit reached. Waiting before the next request.';err.retryAfterMs = blockedUntil - Date.now();throw err;
    }
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
      if (r.status === 429) blockedUntil = Date.now() + Math.max(60000, err.retryAfterMs || 0);
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
  return { async historyPage({ entities, page = 1, start, end }) {
    if (!Array.isArray(entities) || !entities.length || entities.length > 50 || !Number.isSafeInteger(page) || page < 1 || page > 1000) throw new Error('Invalid history query');
    const url = new URL('changes', base);
    url.searchParams.set('project_id', projectId);url.searchParams.set('per_page', '50');url.searchParams.set('page', String(page));
    url.searchParams.set('start_time', new Date(start).toISOString());url.searchParams.set('end_time', new Date(end).toISOString());
    for (const entity of entities) {
      if (!['campaign', 'experiment', 'variation'].includes(entity.type) || !/^\d+$/.test(entity.id)) throw new Error('Invalid history entity');
      url.searchParams.append('entity', `${entity.type}:${entity.id}`);
    }
    const { data, headers } = await get(url);
    const records = Array.isArray(data) ? data : data?.results || data?.items;
    if (!Array.isArray(records)) throw new Error('Unexpected history response');
    const next = headers.get('link')?.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (next) {
      const target = new URL(next[1], base);
      if (target.origin !== base.origin || target.pathname !== url.pathname) throw new Error('Unexpected history pagination host');
    }
    return { records, hasMore: Boolean(next) || records.length === 50 };
  }, async snapshot() {
    const before = calls;
    const [campaigns, experiments, pages, audiences] = await Promise.all(['campaigns', 'experiments', 'pages', 'audiences'].map(list));
    const snapshot = summarize({ project_id: projectId, project: { name: projectName }, retrieved_at: new Date().toISOString(), campaigns, experiments, pages, audiences });
    return { ...snapshot, apiCalls: calls - before };
  } };
}
module.exports = { createOptimizelyClient };
