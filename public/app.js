const $ = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localeNames = { enus: 'US English', esus: 'US Spanish', enca: 'CA English', frca: 'CA French', esmx: 'MX Spanish' };
const viewStorageKey = 'optimizely-dashboard-view';
function savedMode() {
  try { return localStorage.getItem(viewStorageKey) === 'analytics' ? 'analytics' : 'campaigns'; }
  catch { return 'campaigns'; }
}
function selectMode(mode) {
  state.mode = mode === 'analytics' ? 'analytics' : 'campaigns';
  try { localStorage.setItem(viewStorageKey, state.mode); } catch {}
  render();
}
let state = { data: null, projectId: '', view: 'all', query: '', market: 'us-ca', environment: 'all', sort: 'name', mode: savedMode(), promoAttribute: 'all', promoCoverage: 'with', reviewOnly: false };
let timer, loading = false, openId = null, detailView = 'configuration';
function display(c) { return c.display || { ...c.annotation, name: c.annotation.name || c.apiName, sources: {}, warnings: [] }; }
function title(c) { return display(c).name; }
function source(c, field) { return display(c).sources[field] || 'Tracker fallback'; }
function designLink(c, compact=false) {
  const value=display(c).design;if(!value)return '';
  try {const url=new URL(value);if(url.protocol!=='https:' || url.username || url.password)return '';
    const label=/(^|\.)figma\.com$/.test(url.hostname)?'Figma':url.hostname==='xd.adobe.com'?'Adobe XD':'Design';
    return `<a class="design-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" title="Design reference · ${escape(source(c,'design'))}">${compact?'Design':label} ↗</a>`;
  }catch{return '';}
}
function date(value) { if (!value) return 'Not specified'; const d = new Date(value); return Number.isFinite(d.valueOf()) ? d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' }) : 'Not specified'; }
function scoped() {
  return (state.data?.items || []).filter(c => (state.market === 'all' || c.region === state.market || c.region === 'unknown') && (state.environment === 'all' || state.environment === 'production' && c.environments.includes('production') || state.environment === 'uat' && c.environments.includes('uat') && !c.environments.includes('production') && !c.environments.includes('unscoped') || state.environment === 'unknown' && (!c.environments.length || c.environments.includes('unscoped'))));
}
function visible() {
  return scoped().filter(c => (state.view === 'all' || c.group === state.view) && (!state.query || [title(c), c.apiName, c.id, display(c).story, display(c).owner, c.annotation.area, c.annotation.notes, ...c.audiences, ...c.pages].join(' ').toLowerCase().includes(state.query) || state.mode==='analytics' && JSON.stringify(c.analytics || {}).toLowerCase().includes(state.query)))
    .sort((a,b) => state.sort === 'started' ? (Date.parse(b.started) || 0) - (Date.parse(a.started) || 0) : state.sort === 'experiences' ? b.experienceCount-a.experienceCount : title(a).localeCompare(title(b)));
}
function render() {
  if (!state.data) return;
  const all = scoped(), welcome = all.filter(c => c.group === 'new-welcome');
  for (const [id,value] of Object.entries({ statAll:all.length, statWelcome:welcome.length, statGeneral:all.length-welcome.length, statExperiences:all.reduce((n,c)=>n+c.experienceCount,0), countAll:all.length,countWelcome:welcome.length,countGeneral:all.length-welcome.length })) $(id).textContent = value;
  $('projectLabel').textContent = state.data.projectName + ' · ' + state.data.projectId;
  const sync = state.data.sync;
  $('syncTime').textContent = (sync.syncing ? 'Syncing · ' : '') + 'Last synced ' + (sync.fetchedAt ? new Date(sync.fetchedAt).toLocaleString([], { month:'short',day:'numeric',hour:'numeric',minute:'2-digit' }) : 'never');
  $('cacheInfo').textContent = `${sync.cacheMinutes}-minute shared cache · filters make no API calls`;
  $('refresh').disabled = sync.syncing || Boolean(sync.retryAt && Date.parse(sync.retryAt)>Date.now());
  $('refresh').firstChild.textContent = sync.syncing ? 'Syncing… ' : 'Sync now ';
  $('refresh').title = sync.retryAt ? 'Next refresh available ' + new Date(sync.retryAt).toLocaleTimeString() : 'Refresh campaign configuration';
  const issues = [];
  if (sync.error) issues.push(sync.error);
  else if (sync.stale) issues.push('Showing an older saved snapshot. ' + (sync.syncing ? 'Live data is being refreshed.' : 'A live refresh will be retried automatically.'));
  const unknown = all.filter(c => c.region === 'unknown').length;
  if (unknown && state.market!=='all') issues.push(`${unknown} campaign${unknown===1?' has':'s have'} unspecified market targeting and ${unknown===1?'is':'are'} included for review.`);
  const fieldIssues = all.filter(c => display(c).warnings.length).length;
  if (fieldIssues) issues.push(`${fieldIssues} campaign${fieldIssues===1?' has':'s have'} custom fields needing review. Saved fallbacks are shown; open campaign details for the reason.`);
  $('notice').hidden = !issues.length; $('notice').textContent = issues.join(' '); $('notice').classList.toggle('error', Boolean(sync.error));
  const items = visible(); $('resultCount').textContent = `${items.length} campaign${items.length===1?'':'s'} shown${state.query ? ' matching your search' : ''}`;
  $('export').disabled = !items.length;
  $('rows').innerHTML = items.length ? items.map(c => {
    const story = display(c).story || '', ids = [...new Set(story.match(source(c,'story')==='Optimizely' ? /\d+/g : /\b\d{5,7}\b/g)||[])];
    const storyUrl = /^https:\/\/dev\.azure\.com\//i.test(display(c).storyUrl || '') ? display(c).storyUrl : null;
    const unresolved = /candidate|no match/i.test(story);
    return `<tr><td><button class="campaign-name" data-details="${c.id}" title="${escape(title(c))} · Name source: ${escape(source(c,'name'))}">${escape(title(c))}</button><div class="api-name" title="${escape(c.apiName)}">${escape(c.apiName)}</div>${c.environments.includes('uat')&&!c.environments.includes('production')&&!c.environments.includes('unscoped')?'<span class="badge warning">UAT only</span>':''}${c.warnings.length || display(c).warnings.length?'<span class="badge gray">Review targeting</span>':''}</td><td class="audience-cell"><span class="badge ${c.group==='new-welcome'?'orange':''}">${escape(c.audienceKind)}</span></td><td><div class="area">${escape(c.annotation.area || c.pages.slice(0,2).join('\n') || 'Not specified')}</div></td><td class="locale">${c.locales.map(l=>`<span class="locale-tag" title="${escape(localeNames[l]||l)}">${escape(({enus:"US EN",esus:"US ES",enca:"CA EN",frca:"CA FR",esmx:"MX ES"})[l]||l)}</span>`).join('') || 'Unspecified'}</td><td class="owner" title="Source: ${escape(source(c,'owner'))}">${escape(display(c).owner || '—')}</td><td class="number">${c.experienceCount}</td><td class="date">${escape(date(c.started))}</td><td class="story">${storyUrl ? `<a href="${escape(storyUrl)}" target="_blank" rel="noopener noreferrer">${unresolved?'Candidate · ':''}${ids.length?'#'+ids.slice(0,3).join(', #'):'Open story'}${ids.length>3?' +'+(ids.length-3):''} ↗</a>` : `<span class="muted">${story ? escape(story.slice(0,65)) : 'Not linked'}</span>`}<div class="story-note">${escape(source(c,'story'))}</div>${designLink(c,true)}</td><td><button class="detail-button" data-details="${c.id}" aria-label="Details for ${escape(title(c))}">→</button></td></tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">No running campaigns match these filters. Try another audience, environment or search.</td></tr>';
  renderOverview(items);
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===state.view)));
}
function promoValue(r,key) {
  if (!r.payload || !Object.hasOwn(r.payload,key)) return 'Not provided';
  const v=r.payload[key];return v===''?'(blank)':typeof v==='string'?v:JSON.stringify(v);
}
const campaignExpansion = new Map();
function campaignKey(id) { return state.projectId + ":" + id; }
function overviewCampaigns(items=visible(), applyReview=true) {
  return items.map(c=>{
    const all=c.analytics?.records || [];
    const campaignMatch=[title(c),c.apiName,c.id,display(c).story,display(c).owner,c.annotation.area,c.annotation.notes,...c.audiences,...c.pages].join(' ').toLowerCase().includes(state.query);
    const records=all.filter(r=>(!applyReview || !state.reviewOnly || r.status!=='parsed') && (state.promoAttribute==='all' || (state.promoAttribute==='config' ? r.attribute.includes('extension config') : r.attribute===state.promoAttribute)) && (!state.query || campaignMatch || JSON.stringify(r).toLowerCase().includes(state.query)));
    return {c,all,records};
  }).filter(({all,records})=>state.promoCoverage==='none' ? !all.length : state.promoCoverage==='with' ? records.length : state.promoCoverage==='review' ? records.some(r=>r.status!=='parsed') : records.length || !all.length && state.promoAttribute==='all');
}
function renderOverview(items) {
  const active=state.mode==='analytics';
  $('campaignTable').hidden=active;$('analyticsOverview').hidden=!active;$('overviewTools').hidden=!active;
  $('workspacePanel').classList.toggle('analytics-mode',active);
  $('viewHeading').textContent=active?'Campaign analytics':'Active campaigns';
  $('search').placeholder=active?'Search campaign, promo ID, creative or position…':'Search campaign, story, page or audience…';
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode)));
  if(!active)return;
  const campaigns=overviewCampaigns(items),count=campaigns.reduce((n,x)=>n+x.records.length,0),review=campaigns.reduce((n,x)=>n+x.records.filter(r=>r.status!=='parsed').length,0);
  $('resultCount').textContent=`${campaigns.length} campaign${campaigns.length===1?'':'s'} · ${count} promotion placements`;
  const reviewCount=overviewCampaigns(items,false).reduce((n,x)=>n+x.records.filter(r=>r.status!=='parsed').length,0);
  $('reviewOnly').textContent=`Needs review (${reviewCount})`;$('reviewOnly').setAttribute('aria-pressed',String(state.reviewOnly));
  $('expandCampaigns').disabled=$('collapseCampaigns').disabled=!campaigns.length;
  $('promoSummary').textContent=`${count} placements · ${review} needing review`;
  $('export').disabled=!campaigns.length;
  $('promoCampaigns').innerHTML=campaigns.map(({c,all,records})=>{
    const groups=new Map();
    for(const r of records){const key=JSON.stringify([r.attribute,r.status,r.payload,r.status==='parsed'?null:r.raw]);if(!groups.has(key))groups.set(key,{r,placements:[]});groups.get(key).placements.push(r);}
    const expanded=campaignExpansion.get(campaignKey(c.id))!==false;
    return `<article class="campaign-promos"><header data-campaign-toggle="${c.id}"><div><button class="campaign-collapse" aria-expanded="${expanded}" aria-controls="promo-body-${c.id}"><span aria-hidden="true">${expanded?'▾':'▸'}</span> ${escape(title(c))}</button><div class="muted">${escape(c.audienceKind)} · ${escape(c.annotation.area?.split('\n')[0] || c.pages[0] || 'Site area not specified')}</div></div><span class="promo-total">${groups.size} distinct values · ${records.length} placements</span><button class="quiet" data-promo-details="${c.id}" aria-label="Analytics details for ${escape(title(c))}">Details ↗</button></header><div id="promo-body-${c.id}" class="campaign-promo-body"${expanded?'':' hidden'}>${groups.size?`<div class="table-scroll"><table class="promo-table"><thead><tr><th>Creative</th><th>Position</th><th>Promo ID</th><th>Name</th><th>Attribute / status</th><th>Placements</th></tr></thead><tbody>${[...groups.values()].map(({r,placements})=>`<tr><td>${r.status==='parsed'?escape(promoValue(r,'creative')):'<span class="muted">Value requires review</span>'}</td><td class="promo-code">${r.status==='parsed'?escape(promoValue(r,'position')):'—'}</td><td class="promo-code">${r.status==='parsed'?escape(promoValue(r,'id')):'—'}</td><td>${r.status==='parsed'?escape(promoValue(r,'name')):'—'}</td><td><span class="attribute-label">${escape(r.attribute)}</span>${r.status!=='parsed'?`<span class="badge warning">${r.status==='dynamic'?'Dynamic value':'Invalid JSON'}</span>`:''}${r.status!=='parsed'?`<details><summary>Source value</summary><pre>${escape(r.raw)}</pre></details>`:''}</td><td><details><summary>${placements.length} placement${placements.length===1?'':'s'}</summary>${placements.map(p=>`<div class="placement"><strong>${escape(p.experienceName)}</strong><br>${escape(p.variationName)}${p.percent===null?'':` · ${escape(p.percent)}% traffic${p.percent===0?' (not receiving traffic)':''}`}<br><span class="muted">${escape(p.scope)} · ${escape(p.changeType)}${p.changeId?' · '+escape(p.changeId):''}${p.selector?' · '+escape(p.selector):''}</span></div>`).join('')}</details></td></tr>`).join('')}</tbody></table></div>`:`<p class="no-promos">${!c.analytics?'Awaiting next successful sync to load analytics.':'No promotion attributes found in returned changes. Values generated on the site may still exist.'}</p>`}${c.analytics?.warnings.length?`<p class="overview-warning">${c.analytics.warnings.map(escape).join(' ')}</p>`:''}</div></article>`;
  }).join('') || '<p class="empty">No campaigns match these analytics filters.</p>';
}

function projectEndpoint(path) { return path + '?project_id=' + encodeURIComponent(state.projectId); }
async function load() {
  if (loading) return; loading=true; const requestedProject=state.projectId;
  try { const r=await fetch(projectEndpoint('/api/dashboard'));const data=await r.json();if(!r.ok)throw Error(data.error||'Could not load campaigns.');if(requestedProject!==state.projectId)return;state.data=data;render(); }
  catch(e) { if(requestedProject!==state.projectId)return;$('notice').hidden=false;$('notice').classList.add('error');$('notice').textContent=e.message;if(!state.data){$('rows').innerHTML='<tr><td colspan="9" class="empty">Campaign data is unavailable. Check the connection and use Sync now to retry.</td></tr>';$('resultCount').textContent='Connection unavailable';$('refresh').disabled=false;} }
  finally { loading=false;clearTimeout(timer);timer=setTimeout(load,requestedProject!==state.projectId?0:state.data?.sync.syncing?2000:30000); }
}
function section(heading, content) { return `<section class="detail-section"><h3>${heading}</h3>${content}</section>`; }
function analyticsView(c) {
  if (!c.analytics) return section('Analytics attributes','<p>Analytics attributes will be available after the next successful sync.</p>');
  const records = c.analytics.records;
  const experiences = [...new Map(records.filter(r=>r.experienceId).map(r=>[r.experienceId,r.experienceName])).entries()];
  return section('Analytics attributes', `<p>Configured promotion metadata from changes in running experiences. These are tracking values, not clicks, impressions or performance results. Zero-traffic variations are labeled. Scripts are not executed.</p>${c.analytics.warnings.map(w=>`<p class="field-warning">${escape(w)}</p>`).join('')}${records.length?`<div class="analytics-filters"><label>Experience<select id="analyticsExperience"><option value="">All experiences</option>${experiences.map(([id,name])=>`<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select></label><label>Find a value<input id="analyticsSearch" type="search" placeholder="ID, creative, position or variation…"></label></div><p id="analyticsCount" aria-live="polite"></p><div id="analyticsRecords"></div>`:'<p>No data-opt-promo, data-gtm-promo or promo extension configurations were found in the returned changes. Runtime-generated attributes may still exist on the site.</p>'}`);
}
function renderAnalytics(c) {
  if (!$('analyticsRecords')) return;
  const query=$('analyticsSearch').value.trim().toLowerCase(), experience=$('analyticsExperience').value;
  const records=c.analytics.records.filter(r=>(!experience||!r.experienceId||r.experienceId===experience)&&(!query||JSON.stringify(r).toLowerCase().includes(query)));
  $('analyticsCount').textContent=`${records.length} of ${c.analytics.records.length} promotion records shown`;
  function value(r,key) { return r.payload && Object.hasOwn(r.payload,key) ? (r.payload[key]===''?'(blank)':typeof r.payload[key]==='string'?r.payload[key]:JSON.stringify(r.payload[key])) : 'Not provided'; }
  $('analyticsRecords').innerHTML=records.map(r=>`<article class="promo-card"><h4>${escape(r.attribute)}</h4><p>${escape(r.experienceName)}<br>${escape(r.variationName)}${r.percent===null?'':` · ${escape(r.percent)}% traffic${r.percent===0?' (not receiving traffic)':''}`}</p>${r.status==='parsed'?`<dl class="promo-values">${['id','name','creative','position'].map(key=>`<dt>${key}</dt><dd>${escape(value(r,key))}</dd>`).join('')}</dl>`:`<p class="field-warning">${r.status==='dynamic'?'Dynamic value: computed by JavaScript; cannot be resolved from configuration alone.':'Could not parse this attribute as a JSON object. Review the source value.'}</p>`}<p class="promo-source">${escape(r.scope)} · ${escape(r.changeType)}${r.changeId?' · Change '+escape(r.changeId):''}${r.pageId?' · Page '+escape(r.pageId):''}<br>${escape(r.path)}${r.selector?' · Selector: '+escape(r.selector):''}${r.occurrences>1?' · '+r.occurrences+' identical occurrences in this change':''}</p><details><summary>${r.status==='parsed'?'Full promo JSON':'Source value'}</summary><pre>${escape(r.payload?JSON.stringify(r.payload,null,2):r.raw)}</pre></details></article>`).join('')||'<p>No promo records match these filters.</p>';
}
function details(id, editing=false, view = id===openId ? detailView : 'configuration') {
  const c=state.data.items.find(x=>x.id===id); if(!c)return;openId=id;detailView=view;
  const a=c.annotation;
  let content=`<h2>${escape(title(c))}</h2><div class="detail-api">${escape(c.apiName)} · ${c.id}</div><div class="detail-toolbar"><a href="${escape(c.link)}" target="_blank" rel="noopener noreferrer">Open in Optimizely ↗</a>${designLink(c)}<button id="editAnnotation" class="quiet">${editing?'View configuration':'Edit local details'}</button></div>`;
  if(!editing) content+=`<div class="detail-tabs" role="group" aria-label="Campaign detail view"><button data-detail-view="configuration" aria-pressed="${view==='configuration'}">Configuration</button><button data-detail-view="analytics" aria-pressed="${view==='analytics'}">Analytics${c.analytics?' ('+c.analytics.records.length+')':''}</button></div>`;
  if(editing) {
    content+=`<p class="muted">Edit saved fallback values below. Populated Optimizely custom fields take priority; update those in Optimizely.</p><form id="annotationForm"><label class="full">Descriptive name<input name="name" maxlength="250" value="${escape(a.name||'')}"></label><label class="full">Design reference (optional)<input name="design" type="url" maxlength="2000" placeholder="https://www.figma.com/… or https://xd.adobe.com/…" value="${escape(a.design||'')}"></label><label>Owner<input name="owner" maxlength="200" value="${escape(a.owner||'')}"></label><label>Planned end date<input name="plannedEnd" type="date" value="${escape(a.plannedEnd||'')}"></label><label class="full">User Story text<textarea name="story" maxlength="3000">${escape(a.story||'')}</textarea></label><label class="full">Primary Azure DevOps story link<input name="storyUrl" type="url" maxlength="1000" value="${escape(a.storyUrl||'')}"></label><label class="full">Page / site area<textarea name="area" maxlength="3000">${escape(a.area||'')}</textarea></label><label class="full">Notes<textarea name="notes" maxlength="5000">${escape(a.notes||'')}</textarea></label><div class="form-actions full"><button type="submit" class="primary">Save details</button><span class="muted">Saved locally. Does not change Optimizely.</span></div><p id="formError" class="full" role="alert"></p></form>`;
  } else if(view==='analytics') {
    content+=analyticsView(c);
  } else {
    content+=section('Audience & targeting', `<p><strong>${escape(c.audienceKind)}</strong> · ${escape(c.type)} · ${escape(c.environments.join(' + ')||'Environment needs review')}</p><p>${escape(c.audiences.join('\n')||'Everyone (no audience restriction)')}</p>${c.warnings.map(w=>`<p>${escape(w)}</p>`).join('')}`);
    const resolved = display(c);
    content+=section('Field sources',`<p>Name: ${escape(source(c,'name'))}<br>User Story: ${escape(source(c,'story'))}<br>Owner: ${escape(source(c,'owner'))}<br>Design: ${escape(source(c,'design'))}</p>${resolved.warnings.map(w=>`<p class="field-warning">${escape(w)}</p>`).join('')}`);
    const resolvedStoryUrl = /^https:\/\/dev\.azure\.com\//i.test(resolved.storyUrl || '') ? resolved.storyUrl : '';
    content+=section('Work item & ownership',`<p>${resolvedStoryUrl?`<a href="${escape(resolvedStoryUrl)}" target="_blank" rel="noopener noreferrer">${escape(resolved.story||'Open User Story')} ↗</a>`:escape(resolved.story||'No story linked.')}</p><p>Owner: ${escape(resolved.owner||'Not specified')}<br>Planned end: ${escape(date(a.plannedEnd))}</p><p class="muted">Populated Optimizely custom fields take priority. Tracker and local values are used when blank. No Azure DevOps API calls are made.</p>`);
    content+=section('Running experiences',c.experiences.map(e=>`<div class="experience"><h4>${escape(e.name)}</h4><p>${escape(e.audiences.join(' · ')||'Everyone')}</p><p>Eligible traffic: ${e.eligiblePercent===null?'Not specified':escape(e.eligiblePercent)+'%'} · First activated: ${escape(date(e.started))}</p><p>${e.variations.map(v=>escape(v.name)+' ('+(v.percent===null?'unspecified':escape(v.percent)+'%')+')').join(' · ')||'No active variations'}</p></div>`).join('')||'<p>No running experiences in the current snapshot.</p>');
    content+=section('URL rules',c.urlRules.map(r=>`<p><span class="badge ${r.excluded?'warning':'gray'}">${r.excluded?'Exclude':'Include'} · ${escape(r.match)}</span> ${escape(r.value)}</p>`).join('')||'<p>No URL rules found in this snapshot.</p>');
    if(a.notes||c.description)content+=section('Notes',`<p>${escape(a.notes||c.description)}</p>`);
  }
  $('detailContent').innerHTML=content;$('editAnnotation').onclick=()=>details(id,!editing);
  document.querySelectorAll('[data-detail-view]').forEach(button=>button.onclick=()=>details(id,false,button.dataset.detailView));
  if(!editing && view==='analytics') {
    renderAnalytics(c);
    if($('analyticsSearch'))$('analyticsSearch').oninput=()=>renderAnalytics(c);
    if($('analyticsExperience'))$('analyticsExperience').onchange=()=>renderAnalytics(c);
  }
  if(editing)$('annotationForm').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {const body=Object.fromEntries(new FormData(event.currentTarget));const r=await fetch(projectEndpoint('/api/annotations/'+id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);await load();details(id);toast('Campaign details saved');}
    catch(e){$('formError').textContent=e.message;}finally{button.disabled=false;}
  };
  if(!$('details').open)$('details').showModal();
}
function toast(text) { $('toast').textContent=text;$('toast').hidden=false;setTimeout(()=>$('toast').hidden=true,3500); }
$('rows').onclick=e=>{const button=e.target.closest('[data-details]');if(button)details(button.dataset.details);};
$('closeDetails').onclick=()=>$('details').close();
$('details').addEventListener('click',e=>{if(e.target===$('details') && e.offsetX<0)$('details').close();});
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;render();});
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>selectMode(b.dataset.mode));
for(const id of ['promoAttribute','promoCoverage'])$(id).onchange=e=>{state[id]=e.target.value;if(id==='promoCoverage')state.reviewOnly=false;render();};
$('reviewOnly').onclick=()=>{state.reviewOnly=!state.reviewOnly;if(state.reviewOnly)state.promoCoverage='with';$('promoCoverage').value=state.promoCoverage;render();};
for(const [id,expanded] of [['expandCampaigns',true],['collapseCampaigns',false]])$(id).onclick=()=>{for(const {c} of overviewCampaigns())campaignExpansion.set(campaignKey(c.id),expanded);render();};
$('promoCampaigns').onclick=e=>{const b=e.target.closest('[data-promo-details]');if(b){details(b.dataset.promoDetails,false,'analytics');return;}const toggle=e.target.closest('[data-campaign-toggle]');if(toggle){const id=toggle.dataset.campaignToggle;campaignExpansion.set(campaignKey(id),campaignExpansion.get(campaignKey(id))===false);render();}};
$('search').oninput=e=>{state.query=e.target.value.trim().toLowerCase();render();};
for(const id of ['market','environment','sort'])$(id).onchange=e=>{state[id]=e.target.value;render();};
$('refresh').onclick=async()=>{const button=$('refresh');button.disabled=true;try{const r=await fetch(projectEndpoint('/api/refresh'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('Could not start sync.');await load();}catch(e){toast(e.message);button.disabled=false;}};
function csv(value) { let s=String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'; }
$('export').onclick=()=>{
  const rows=state.mode==='analytics' ? [['Campaign ID','Campaign','Attribute','Status','id','name','creative','position','Experience','Variation','Traffic %','Scope','Change ID','Selector','Source value','Design URL'],...overviewCampaigns().flatMap(({c,records})=>records.map(r=>[c.id,title(c),r.attribute,r.status,...['id','name','creative','position'].map(k=>r.payload?.[k]??''),r.experienceName,r.variationName,r.percent,r.scope,r.changeId,r.selector,r.raw || JSON.stringify(r.payload),display(c).design]))] : [['Campaign ID','Descriptive name','API name','Audience view','Audience','Page / site area','Locales','Experiences','First activated','User Story','Story URL','Optimizely URL','Data fetched at','Owner','Name source','User Story source','Owner source','Custom field review','Design URL','Design source'],...visible().map(c=>[c.id,title(c),c.apiName,c.group,c.audiences.join('; '),c.annotation.area||c.pages.join('; '),c.locales.join('; '),c.experienceCount,c.started,display(c).story,display(c).storyUrl,c.link,state.data.fetchedAt,display(c).owner,source(c,'name'),source(c,'story'),source(c,'owner'),display(c).warnings.join('; '),display(c).design,source(c,'design')])];
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=state.projectId+'-'+(state.mode==='analytics'?'optimizely-analytics-':'active-optimizely-campaigns-')+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
async function initializeProjects() {
  try {
    const r=await fetch('/api/projects');if(!r.ok)throw Error('Could not load projects.');const data=await r.json();
    let saved;try{saved=localStorage.getItem('optimizely-dashboard-project');}catch{}
    const selected=data.projects.find(p=>p.id===saved) || data.projects.find(p=>p.id===data.defaultProjectId) || data.projects[0];
    $('project').innerHTML=data.projects.map(p=>`<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
    async function switchProject(id) {
      const project=data.projects.find(p=>p.id===id);if(!project)return;
      state.projectId=id;state.market=project.market;state.data=null;state.query='';$('search').value='';$('market').value=state.market;$('project').value=id;
      try{localStorage.setItem('optimizely-dashboard-project',id);}catch{}
      if($('details').open)$('details').close();openId=null;
      for(const key of ['statAll','statWelcome','statGeneral','statExperiences','countAll','countWelcome','countGeneral'])$(key).textContent='—';
      $('projectLabel').textContent=project.name+' · '+id;$('resultCount').textContent='Loading this project…';$('syncTime').textContent='Loading project snapshot…';$('notice').hidden=true;$('export').disabled=true;
      $('rows').innerHTML='<tr><td colspan="9" class="empty">Loading this project…</td></tr>';
      $('promoCampaigns').innerHTML='<p class="empty">Loading this project…</p>';
      $('reviewOnly').textContent='Needs review';$('reviewOnly').setAttribute('aria-pressed',String(state.reviewOnly));
      $('expandCampaigns').disabled=$('collapseCampaigns').disabled=true;$('promoSummary').textContent='';
      clearTimeout(timer);await load();
    }
    $('project').onchange=e=>switchProject(e.target.value);
    await switchProject(selected.id);
  }catch(e){$('notice').hidden=false;$('notice').textContent=e.message;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden && state.projectId)load();});
if(typeof ResizeObserver!=='undefined')new ResizeObserver(entries=>{for(const entry of entries)$('workspacePanel').style.setProperty('--controls-height',entry.target.getBoundingClientRect().height+'px');}).observe($('workspaceControls'));
initializeProjects();
