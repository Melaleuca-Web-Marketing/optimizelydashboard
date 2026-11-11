const ATTR = /^data-(opt|gtm)-promo$/i;
function decodeEntities(value) {
  let text = value;
  for (let i = 0; i < 3; i++) {
    const next = text.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
      const named = { '&quot;':'"', '&apos;':"'", '&amp;':'&', '&lt;':'<', '&gt;':'>' };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const hex = /^&#x/i.test(entity), code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
    if (next === text) break; text = next;
  }
  return text;
}
function quoted(text, start) {
  const quote = text[start]; let value = '';
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === quote) return { value, end: i + 1 };
    if (text[i] === '\\' && i + 1 < text.length) { value += text[i] + text[++i]; }
    else value += text[i];
  }
  return null;
}
function unescapeString(text) {
  return text.replace(/\\(["'\\/bfnrt])/g, (_, c) => ({ b:'\b', f:'\f', n:'\n', r:'\r', t:'\t' }[c] ?? c));
}
function payload(value) {
  let candidate = value;
  for (let i = 0; i < 4 && typeof candidate === 'string'; i++) {
    const decoded = decodeEntities(candidate).trim();
    try { candidate = JSON.parse(decoded); }
    catch {
      const unescaped = unescapeString(decoded);
      if (unescaped === candidate || unescaped === decoded) return null;
      candidate = unescaped;
    }
  }
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
}

function campaignAnalytics(campaign, experiences, standalone = false) {
  const records = new Map(), warnings = new Set();
  function change(change, context) {
    const origin = { ...context, changeId: String(change.id || ''), changeType: change.type || '', selector: change.selector || '' };
    function add(attribute, value, path, dynamic = false) {
      const data = dynamic ? null : payload(value);
      const raw = typeof value === 'string' ? decodeEntities(value) : JSON.stringify(value);
      const status = data ? 'parsed' : dynamic ? 'dynamic' : 'invalid';
      const record = { ...origin, attribute, path, status, payload: data, raw: raw || '', occurrences: 1 };
      const key = JSON.stringify([context, origin.changeId, attribute, status, data || raw]);
      const previous = records.get(key);
      if (previous) previous.occurrences++; else records.set(key, record);
    }
    function visit(value, path = '', depth = 0) {
      if (depth > 20) { warnings.add('Deeply nested change content was not fully inspected.'); return; }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          const childPath = path ? `${path}.${key}` : key;
          if (ATTR.test(key)) add(key.toLowerCase(), child, childPath);
          // Extension configurations can generate a promo attribute at render time.
          if ((key === 'gtmPromo' || key === 'optPromo') && child != null && child !== '') add(`${key} (extension config)`, child, childPath);
          visit(child, childPath, depth + 1);
        }
        return;
      }
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (/^[\[{"]/.test(trimmed)) {
        try { const nested = JSON.parse(trimmed); if (nested !== value) visit(nested, path + ' [JSON]', depth + 1); } catch { /* Also inspect HTML/code below. */ }
      }
      // Read original quote boundaries before decoding &quot; inside the attribute.
      const attr = /\b(data-(?:opt|gtm)-promo)\s*=\s*(["'])/gi;
      let match;
      while ((match = attr.exec(value))) {
        const literal = quoted(value, attr.lastIndex - 1);
        if (literal) { add(match[1].toLowerCase(), literal.value, path); attr.lastIndex = literal.end; }
      }
      const setters = /(?:setAttribute\s*\(\s*(["'])(data-(?:opt|gtm)-promo)\1\s*,\s*|\bdataset\.(optPromo|gtmPromo)\s*=\s*)/gi;
      while ((match = setters.exec(value))) {
        const attribute = match[2]?.toLowerCase() || (match[3].toLowerCase() === 'optpromo' ? 'data-opt-promo' : 'data-gtm-promo');
        const start = setters.lastIndex, literal = /["']/.test(value[start] || '') ? quoted(value, start) : null;
        if (literal) { add(attribute, unescapeString(literal.value), path); setters.lastIndex = literal.end; }
        else add(attribute, value.slice(start, start + 240), path, true);
      }
    }
    if (change.async && change.src && !change.value) warnings.add('Some change code is loaded externally and is not included in the API response. External code was not fetched.');
    // Never execute code, load image/share URLs or retain the full change source.
    for (const key of ['value', 'attributes', 'config', 'css']) visit(change[key], key);
  }
  const base = { scope:'Campaign shared', experienceId:'', experienceName:'All running experiences', variationId:'', variationName:'All variations', percent:null, pageId:'' };
  if (!standalone) for (const c of campaign.changes || []) change(c, base);
  for (const e of experiences) {
    const shared = { ...base, scope:'Experience shared', experienceId:String(e.id), experienceName:e.name || String(e.id) };
    for (const c of e.changes || []) change(c, shared);
    for (const v of (e.variations || []).filter(v => !v.archived)) {
      for (const a of v.actions || []) for (const c of a.changes || []) change(c, {
        ...shared, scope:'Variation', variationId:String(v.variation_id || v.id || ''), variationName:v.name || 'Variation',
        percent:Number.isFinite(v.weight) ? v.weight / 100 : null, pageId:a.page_id ? String(a.page_id) : '',
      });
    }
  }
  return { records:[...records.values()], warnings:[...warnings] };
}
module.exports = { campaignAnalytics, decodeEntities };
