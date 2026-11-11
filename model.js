const { customFields } = require('./fields');
const { campaignAnalytics } = require('./analytics');
const { PROJECTS } = require('./projects');
const uniq = values => [...new Set(values.filter(v => v !== undefined && v !== null && v !== ''))];
function parse(value) { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } }
function walk(value, fn, negative = false) {
  value = parse(value);
  if (Array.isArray(value)) { const neg = String(value[0]).toLowerCase() === 'not' ? !negative : negative; value.slice(1).forEach(v => walk(v, fn, neg)); }
  else if (value && typeof value === 'object') fn(value, negative);
}
function audienceIds(exp) { const ids = []; walk(exp.audience_conditions, x => { if (x.audience_id) ids.push(String(x.audience_id)); }); return uniq(ids); }
function isWelcome(exp, audiences) {
  let welcome = false;
  walk(exp.audience_conditions, (ref, neg) => {
    if (neg) return;
    const a = audiences.get(String(ref.audience_id));
    if (!a) return;
    if (/newWelcome|WelcomeProgram/i.test(a.name || '')) welcome = true;
    walk(a.conditions, (rule, not) => {
      if (!not && ((rule.name === 'statusL2E' && rule.value === 'WelcomeProgram') || rule.name === 'newWelcomeMonth')) welcome = true;
    });
  });
  return welcome;
}
function targets(campaign, exp, pages) {
  const ids = uniq([...(campaign.page_ids || []), ...(exp.page_ids || []), ...(exp.variations || []).flatMap(v => (v.actions || []).map(a => a.page_id))]);
  const result = ids.map(id => pages.get(String(id))).filter(Boolean);
  for (const owner of [campaign, exp]) if (owner.url_targeting) result.push({ ...owner.url_targeting, name: 'Experiment URL targeting' });
  return result;
}
function summarize(raw) {
  for (const key of ['campaigns', 'experiments', 'pages', 'audiences']) if (!Array.isArray(raw[key])) throw new Error('Incomplete Optimizely snapshot: ' + key);
  const audiences = new Map(raw.audiences.map(a => [String(a.id), a]));
  const pages = new Map(raw.pages.map(p => [String(p.id), p]));
  const experiments = new Map(raw.experiments.map(e => [String(e.id), e]));
  const groups = [], included = new Set();
  for (const c of raw.campaigns.filter(c => c.status === 'running' && !c.archived)) {
    const priorities = (c.experiment_priorities || []).flat(Infinity).map(String);
    const ids = uniq([...priorities, ...raw.experiments.filter(e => String(e.campaign_id) === String(c.id) || (e.campaign_ids || []).map(String).includes(String(c.id))).map(e => String(e.id))]);
    const missing = priorities.filter(id => !experiments.has(id));
    const es = ids.map(id => experiments.get(id)).filter(e => e && e.status === 'running' && !e.archived);
    es.forEach(e => included.add(String(e.id)));
    groups.push({ c, es, standalone: false, missing });
  }
  for (const e of raw.experiments) if (e.status === 'running' && !e.archived && e.type !== 'personalization' && !included.has(String(e.id))) {
    const parents = uniq([e.campaign_id, ...(e.campaign_ids || [])]).map(String);
    // Do not resurrect tests belonging to a paused/archived campaign.
    if (parents.some(id => raw.campaigns.some(c => String(c.id) === id))) continue;
    groups.push({ c: e, es: [e], standalone: true, missing: [] });
  }
  const items = groups.map(({ c, es, standalone, missing }) => {
    const priorityIds = new Set((c.experiment_priorities || []).flat(Infinity).map(String));
    const related = standalone ? [c] : raw.experiments.filter(e => priorityIds.has(String(e.id)) || String(e.campaign_id) === String(c.id) || (e.campaign_ids || []).map(String).includes(String(c.id)));
    const historyEntities = [{ type: standalone ? 'experiment' : 'campaign', id: String(c.id) }];
    for (const id of priorityIds) historyEntities.push({ type: 'experiment', id });
    for (const e of related) {
      historyEntities.push({ type: 'experiment', id: String(e.id) });
      for (const v of e.variations || []) if (v.variation_id || v.id) historyEntities.push({ type: 'variation', id: String(v.variation_id || v.id) });
    }
    const fields = customFields(c, es);
    const allAudienceIds = uniq(es.flatMap(audienceIds));
    const audienceNames = allAudienceIds.map(id => audiences.get(id)?.name || 'Unknown audience ' + id);
    const positiveNames = [];
    const locales = [], rules = [], pageNames = [], detail = [];
    for (const e of es) {
      walk(e.audience_conditions, (ref, neg) => {
        const a = audiences.get(String(ref.audience_id));
        if (!a) return;
        if (!neg) positiveNames.push(a.name);
        walk(a.conditions, (r, not) => { if (!neg && !not && /^(uiCulture|Culture)$/i.test(r.name || '')) locales.push(String(r.value).toLowerCase().replace(/[-_]/g, '')); });
      });
      const ps = targets(c, e, pages);
      for (const p of ps) {
        if (p.name) pageNames.push(p.name);
        walk(p.conditions, (rule, negative) => { if (rule.type === 'url' && rule.value) rules.push({ value: String(rule.value), match: rule.match_type || '', excluded: negative }); });
      }
      const variants = (e.variations || []).filter(v => !v.archived).map(v => ({ name: v.name || 'Variation', percent: Number.isFinite(v.weight) ? v.weight / 100 : null }));
      // holdback and traffic_allocation use basis points; never infer allocation from variation weights.
      const eligiblePercent = Number.isFinite(e.traffic_allocation) ? e.traffic_allocation / 100 : Number.isFinite(c.holdback ?? e.holdback) ? (10000 - (c.holdback ?? e.holdback)) / 100 : null;
      detail.push({ id: String(e.id), name: e.name, audiences: audienceIds(e).map(id => audiences.get(id)?.name || 'Unknown audience ' + id), variations: variants, eligiblePercent, started: e.earliest || e.schedule?.start_time || null, plannedEnd: e.schedule?.stop_time || null });
    }
    const positiveUrls = uniq(rules.filter(r => !r.excluded).map(r => r.value));
    const environments = new Set();
    for (const value of positiveUrls) {
      if (/^https?:\/\/[^/]*(uat|preview|staging|localhost)/i.test(value)) environments.add('uat');
      else if (/^https?:\/\/(www|ca|mx|mexico|ie|uk|pl|de|nl|lt)\.melaleuca\.com(?:\/|$)/i.test(value)) environments.add('production');
      else environments.add('unscoped');
    }
    const group = es.some(e => isWelcome(e, audiences)) ? 'new-welcome' : 'general';
    const explicitTenured = positiveNames.some(n => /tenured/i.test(n || ''));
    const starts = es.map(e => e.earliest).filter(Boolean).sort();
    const localeValues = uniq(locales);
    const projectMarket = PROJECTS.find(p => p.id === String(raw.project_id))?.market;
    const region = projectMarket === 'eu' ? 'eu' : localeValues.some(l => /^esmx$/i.test(l)) || projectMarket === 'mx' ? 'mx' : localeValues.some(l => /^(enus|esus|enca|frca)$/i.test(l)) || environments.has('production') ? 'us-ca' : localeValues.length ? 'other' : 'unknown';
    const warnings = [];
    if (!es.length) warnings.push('Running campaign has no running experiences in this snapshot.');
    if (missing.length) warnings.push(`${missing.length} referenced experiences were missing from the API list.`);
    if (allAudienceIds.some(id => !audiences.has(id))) warnings.push('Some audience definitions are unavailable.');
    if (!environments.size || environments.has('unscoped')) warnings.push('Some URL rules do not establish a host/environment. Review the include/exclude rules.');
    if (group === 'new-welcome' && explicitTenured) warnings.push('Campaign includes both New Welcome and tenured audiences.');
    return {
      id: String(c.id), apiName: c.name || 'Unnamed campaign', type: c.type === 'a/b' ? 'A/B test' : c.type === 'personalization' ? 'Personalization' : c.type || 'Campaign',
      status: 'running', group, audienceKind: explicitTenured ? 'Tenured' : group === 'new-welcome' ? 'New Welcome' : positiveNames.some(n => /Preferred/i.test(n || '')) ? 'Preferred customers' : 'All / other audiences',
      audiences: audienceNames, locales: localeValues, region, environments: [...environments], pages: uniq(pageNames), urlRules: [...new Map(rules.map(r => [JSON.stringify(r), r])).values()],
      started: c.earliest || starts[0] || null, lastModified: c.last_modified || null, description: c.description || '',
      experiences: detail, experienceCount: detail.length, warnings,
      customFields: fields.values, customFieldWarnings: fields.warnings,
      analytics: campaignAnalytics(c, es, standalone),
      historyEntities: [...new Map(historyEntities.filter(e => /^\d+$/.test(e.id)).map(e => [`${e.type}:${e.id}`, e])).values()],
      historyStart: [c.created, ...related.map(e => e.created)].filter(Boolean).sort()[0] || null,
      link: `https://app.optimizely.com/v2/projects/${raw.project_id}/${standalone ? 'experiments' : 'campaigns'}/${c.id}${standalone ? '' : '/summary'}`,
    };
  });
  return { schemaVersion: 7, projectId: String(raw.project_id), projectName: raw.project?.name || 'US/CA Web', fetchedAt: raw.retrieved_at || new Date().toISOString(), items: items.sort((a, b) => a.apiName.localeCompare(b.apiName)) };
}
module.exports = { summarize, isWelcome, walk };
