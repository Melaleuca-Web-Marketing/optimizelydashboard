const { campaignAnalytics } = require('./analytics');
const KEYS = ['id', 'name', 'creative', 'position'];
const PROMO = /^(?:data-(?:opt|gtm)-promo|gtmPromo|optPromo)$/i;
const printable = value => {
  if(value === undefined)return null;
  const result=typeof value === 'string'?value:JSON.stringify(value);
  return result.slice(0,2000)+(result.length>2000?'\n… (value shortened)':'');
};
const signature = r => JSON.stringify([r.status,r.status==='parsed'?KEYS.map(k=>[Object.hasOwn(r.payload,k),r.payload[k]]):r.raw,r.occurrences]);

// Inspect complete API values before history's source-text limits are applied.
function extract(value, property) {
  const records = [], warnings = new Set();let nodes = 0;
  function scan(content, context) {
    const found = campaignAnalytics({ changes: [{ value: content }] }, []);
    for(const warning of found.warnings)warnings.add(warning);
    for (const record of found.records) records.push({ ...record, anchor: context.anchor, comparisonScope: context.scope || property, location: context.location });
  }
  function visit(node, path, context, depth = 0) {
    if (++nodes > 20000 || depth > 20) { warnings.add('Some deeply nested or large content could not be inspected.');return; }
    if (typeof node === 'string') {
      try { const parsed = JSON.parse(node);if (parsed !== node) { visit(parsed, path, context, depth + 1);return; } } catch {}
      scan(node, context);return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child,i)=>visit(child, `${path}[${i}]`, context, depth + 1));return; }
    const next = { ...context };
    // Stable source IDs, rather than promo IDs, anchor comparisons when IDs change.
    if (node.variation_id || node.actions) next.variation = String(node.variation_id || node.id || '');
    if (node.page_id) next.page = String(node.page_id);
    if (node.type && ['value','attributes','config','css'].some(k=>Object.hasOwn(node,k))) {
      next.anchor = `${property}|${next.variation || ''}|${next.page || ''}|${node.id || node.selector || path}`;
      next.scope = `${property}|${next.variation || ''}|${next.page || ''}`;
      next.location = [next.variation && 'Variation ' + next.variation, next.page && 'Page ' + next.page, node.selector].filter(Boolean).join(' · ') || property;
      for (const key of ['value','attributes','config','css']) if (Object.hasOwn(node,key)) scan(node[key], next);
      return;
    }
    for (const [key,child] of Object.entries(node)) {
      const childContext = { ...next, anchor: `${next.anchor}|${key}`, location: next.location || property };
      if (PROMO.test(key)) scan({ [key]: child }, childContext);
      else visit(child, `${path}.${key}`, childContext, depth + 1);
    }
  }
  const context = { anchor: property, location: property };
  if (PROMO.test(property.split('.').at(-1))) scan({ [property.split('.').at(-1)]: value }, context);
  else visit(value, property, context);
  return { records, warnings: [...warnings] };
}

function compareHistoryAnalytics(entry) {
  const items = [], warnings = new Set();
  for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
    const property = String(change.property || 'content');
    const before = extract(change.before, property), after = extract(change.after, property);
    for (const warning of [...before.warnings,...after.warnings]) warnings.add(warning);
    const beforeKnown = Object.hasOwn(change,'before') || entry.change_type === 'create' || /^Added\b/i.test(change.description || '');
    const afterKnown = Object.hasOwn(change,'after') || entry.change_type === 'delete' || /^(Removed|Deleted)\b/i.test(change.description || '');
    const buckets = new Map(), originalCounts=new Map();
    for(const [side,records] of [['before',before.records],['after',after.records]])for(const r of records){const key=r.anchor+'|'+r.attribute;if(!originalCounts.has(key))originalCounts.set(key,{before:0,after:0});originalCounts.get(key)[side]++;}
    // A replacement source change with identical tracking values is not an analytics edit.
    const remainingAfter=after.records.slice();
    const remainingBefore=before.records.filter(old=>{
      const index=remainingAfter.findIndex(next=>old.comparisonScope===next.comparisonScope && old.attribute===next.attribute && signature(old)===signature(next));
      if(index<0)return true;remainingAfter.splice(index,1);return false;
    });
    for (const [side,records] of [['before',remainingBefore],['after',remainingAfter]]) for (const record of records) {
      const key = record.anchor + '|' + record.attribute;
      if (!buckets.has(key)) buckets.set(key,{before:[],after:[],original:originalCounts.get(key)});
      buckets.get(key)[side].push(record);
    }
    function emit(a,b,kind,note='') {
      if(items.length>=100){warnings.add('Additional analytics comparisons were omitted; inspect the source in Optimizely.');return;}
      const record=b||a;
      const fields=KEYS.filter(k=>JSON.stringify(a?.payload?.[k])!==JSON.stringify(b?.payload?.[k])).map(key=>({key,before:printable(a?.payload?.[key]),after:printable(b?.payload?.[key])}));
      if(a && b && a.occurrences!==b.occurrences)fields.push({key:'occurrences',before:String(a.occurrences),after:String(b.occurrences)});
      const item={kind,attribute:record.attribute,location:record.location,property,fields,note,
        beforeStatus:a?.status||'absent',afterStatus:b?.status||'absent',beforeRaw:kind==='review'&&a?printable(a.payload||a.raw):null,afterRaw:kind==='review'&&b?printable(b.payload||b.raw):null};
      items.push(item);return item;
    }
    for (const bucket of buckets.values()) {
      let a=bucket.before.slice(),b=bucket.after.slice();
      const originallySingle=bucket.original.before<=1 && bucket.original.after<=1;
      // Equal parsed values are independent of JSON key order and HTML quote encoding.
      a=a.filter(old=>{const i=b.findIndex(next=>signature(old)===signature(next));if(i<0)return true;b.splice(i,1);return false;});
      function pair(old,next) {
        if(old.status==='parsed' && next.status==='parsed')emit(old,next,'changed');
        else emit(old,next,'review',`${old.status} → ${next.status}. Values cannot be fully compared.`);
      }
      // Match only unique unchanged positions/IDs. Never assume list order is identity.
      for (const key of ['position','id']) {
        for (const old of a.slice()) {
          const value=old.payload?.[key];if(value==null||value==='')continue;
          const left=a.filter(r=>r.payload?.[key]===value),right=b.filter(r=>r.payload?.[key]===value);
          if(left.length===1 && right.length===1){pair(old,right[0]);a.splice(a.indexOf(old),1);b.splice(b.indexOf(right[0]),1);}
        }
      }
      if(originallySingle && a.length===1 && b.length===1){pair(a[0],b[0]);a=[];b=[];}
      if(a.length && b.length){
        const uncertain=emit(a[0],b[0],'review',`Ambiguous placement match: ${a.length} previous and ${b.length} new values. Review the source; these are not confirmed field changes.`);
        // Do not display arbitrarily paired values as a confirmed comparison.
        if(uncertain){uncertain.fields=[];uncertain.beforeRaw=null;uncertain.afterRaw=null;}continue;
      }
      for(const old of a)emit(old,null,afterKnown && old.status==='parsed'?'removed':'review',afterKnown?'':'After-value was not supplied; removal cannot be confirmed.');
      for(const next of b)emit(null,next,beforeKnown && next.status==='parsed'?'added':'review',beforeKnown?'':'Before-value was not supplied; addition cannot be confirmed.');
    }
  }
  return { version:1, items, warnings:[...warnings] };
}
module.exports = { compareHistoryAnalytics, extract };
