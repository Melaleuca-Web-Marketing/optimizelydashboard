const FIELD_KEYS = ['user-story', 'campaign-descriptive-name', 'assignment', 'design'];
const STORY_BASE = 'https://dev.azure.com/MelaleucaPlatform/Melaleuca/_workitems/edit/';
const blank = value => value == null || typeof value === 'string' && !value.trim();

function customFields(campaign, experiences) {
  const values = {}, warnings = [];
  const own = campaign.custom_field_values || {};
  for (const key of FIELD_KEYS) {
    if (Object.hasOwn(own, key)) { values[key] = own[key]; continue; }
    const inherited = experiences.map(e => e.custom_field_values?.[key]).filter(v => !blank(v));
    const unique = [...new Map(inherited.map(v => [JSON.stringify(v), v])).values()];
    if (unique.length === 1) values[key] = unique[0];
    else if (unique.length > 1) warnings.push(`Optimizely ${key} differs between experiences. Using the saved fallback until reviewed.`);
  }
  return { values, warnings };
}

function storyId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.0+)?$/.test(value.trim()))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function designUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function resolveFields(item, annotation = {}) {
  const custom = item.customFields || {}, warnings = [...(item.customFieldWarnings || [])];
  const fallbackSource = annotation.updatedAt ? 'Local fallback' : 'Tracker fallback';
  const sources = {};
  function text(key, local, empty, sourceKey) {
    const value = custom[key];
    if (!blank(value) && typeof value === 'string') { sources[sourceKey] = 'Optimizely'; return value.trim(); }
    if (!blank(value)) warnings.push(`Optimizely ${key} must contain text. Using the saved fallback.`);
    if (typeof local === 'string' && local.trim()) { sources[sourceKey] = fallbackSource; return local.trim(); }
    sources[sourceKey] = empty ? 'API name' : 'Not provided';
    return empty || '';
  }
  const name = text('campaign-descriptive-name', annotation.name, item.apiName, 'name');
  const owner = text('assignment', annotation.owner, '', 'owner');
  let design = designUrl(annotation.design);
  sources.design = design ? fallbackSource : 'Not provided';
  if (!blank(custom.design)) {
    const url = designUrl(custom.design);
    if (url) { design = url; sources.design = 'Optimizely'; }
    else warnings.push('Optimizely Design must be a valid HTTPS link. Using the saved design fallback.');
  }
  let story = annotation.story || '', storyUrl = annotation.storyUrl || '';
  sources.story = story || storyUrl ? fallbackSource : 'Not provided';
  if (!blank(custom['user-story'])) {
    const id = storyId(custom['user-story']);
    if (id) {
      // Replace story text and link together; the old title may describe another story.
      story = `User Story #${id}`; storyUrl = STORY_BASE + id; sources.story = 'Optimizely';
    } else warnings.push('Optimizely User Story must be a positive whole number. Using the saved story fallback.');
  }
  return { name, owner, story, storyUrl, design, sources, warnings };
}
module.exports = { customFields, resolveFields, storyId, designUrl };
