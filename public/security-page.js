const $ = id => document.getElementById(id);
const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const WHERE = { 'project-javascript': 'Project JavaScript', 'experiment-code': 'Experiment code', 'page-activation': 'Page activation code', extension: 'Extension', 'published-snippet': 'Published snippet (incl. Project JS)', 'widget-config': 'Widget settings', 'audience-code': 'Audience JavaScript condition' };
const state = { projectId: '', data: null };
const endpoint = path => '.' + path + '?project_id=' + encodeURIComponent(state.projectId);
function toast(message) { const t = $('toast'); t.textContent = message; t.hidden = false; setTimeout(() => { t.hidden = true; }, 4000); }
function cell(text, className) { const td = document.createElement('td'); td.textContent = text; if (className) td.className = className; return td; }
const who = by => by.map(b => `${b.user} via ${b.source || '?'} (${b.action}, ${new Date(b.at).toLocaleString()})`).join('; ');
function explainText(x) {
  if (!x) return '';
  if (x.status === 'explained') return ' · publish matches change history: ' + who(x.by);
  if (x.status === 'unexplained') return ' · NO matching change-history entry for this modification time: investigate';
  if (x.status === 'outside-window') return ' · last modified before the change-history window, so it cannot be matched';
  return '';
}
function row(...cells) { const tr = document.createElement('tr'); for (const c of cells) tr.append(cell(c)); return tr; }
function renderDrift(d) {
  const dr = d.drift, body = $('driftRows'); body.replaceChildren();
  if (!dr) { $('driftLabel').textContent = 'Not available for this scan'; return; }
  const c = dr.counts;
  $('driftLabel').textContent = (!dr.baselineAt ? 'No baseline yet: this scan becomes the baseline' : `${c.added} added · ${c.changed} changed · ${c.removed} removed · ${c.unexplained} without a change-history entry (baseline ${new Date(dr.baselineAt).toLocaleString()})`)
    + (dr.historyAvailable ? '' : ' · change history unavailable: ' + (dr.historyError || 'unknown reason')) + (dr.historyTruncated ? ' · change history truncated' : '');
  const items = [...dr.changed.map(i => ['Changed', i]), ...dr.added.map(i => ['Added', i]), ...dr.removed.map(i => ['Removed', i])];
  if (!items.length) { const tr = row(dr.baselineAt ? 'No code changes since the baseline.' : 'Run another scan to see changes.'); tr.firstChild.colSpan = 4; body.append(tr); }
  for (const [label, i] of items) {
    const tr = row(label, i.type, `${i.name} (${i.id})${i.status ? ' · ' + i.status : ''}`, i.by.length ? who(i.by) : i.unexplained ? 'NO CHANGE-HISTORY ENTRY: investigate' : label === 'Removed' ? 'n/a (removed)' : 'change history unavailable');
    if (i.unexplained) { tr.firstChild.style.fontWeight = '700'; tr.lastChild.style.fontWeight = '700'; }
    body.append(tr);
  }
  const recent = d.recentChanges || [], rb = $('recentRows'); rb.replaceChildren();
  $('recentCount').textContent = recent.length ? `(${recent.length})` : '';
  for (const e of recent.slice(0, 100)) rb.append(row(new Date(e.at).toLocaleString(), e.user, e.source, e.action, `${e.entityType}: ${e.entityName} (${e.entityId})`));
}
function render() {
  const d = state.data; if (!d) return;
  renderDrift(d);
  $('statCritical').textContent = d.counts.critical; $('statHigh').textContent = d.counts.high; $('statMedium').textContent = d.counts.medium;
  $('statScanned').textContent = d.scannedSources;
  $('statScannedDetail').textContent = `${d.scannedExperiments} experiments · ${d.scannedPages} pages`;
  $('projectLabel').textContent = d.projectName;
  $('scanTime').textContent = 'Scanned ' + new Date(d.fetchedAt).toLocaleString();
  $('cacheInfo').textContent = `Server cache · ${d.apiCalls ?? '?'} API calls for last scan`;
  const sn = d.snippet, info = $('snippetInfo');
  if (!sn) info.hidden = true;
  else {
    info.hidden = false;
    info.textContent = sn.error ? 'Published snippet: ' + sn.error
      : `Published snippet: ${(sn.bytes / 1048576).toFixed(2)} MB · SHA-256 ${sn.sha256.slice(0, 12)}… · last modified ${sn.lastModified || 'unknown'}`
        + explainText(sn.explanation)
        + (sn.changedSinceLastScan === true ? ' · CHANGED since the previous scan (' + new Date(sn.previousScannedAt).toLocaleString() + '); expected if experiments were published' : sn.changedSinceLastScan === false ? ' · unchanged since the previous scan' : ' · first scan, no baseline yet');
  }
  const min = RANK[$('severity').value], hideArchived = $('hideArchived').checked;
  const rows = d.findings.filter(f => RANK[f.severity] >= min && !(hideArchived && f.archived));
  const body = $('rows'); body.replaceChildren();
  if (!rows.length) { const tr = document.createElement('tr'); tr.append(cell(d.findings.length ? 'No findings at this severity.' : 'No findings. Nothing matched the scan rules.')); tr.firstChild.colSpan = 5; body.append(tr); return; }
  for (const f of rows) {
    const tr = document.createElement('tr');
    const where = (WHERE[f.kind] || f.kind) + (f.variation ? ' · ' + f.variation : '') + (f.kind === 'extension' && f.field ? ' · ' + f.field : '');
    const name = f.entityName + (f.entityId ? ' (' + f.entityId + ')' : '') + (f.status ? ' · ' + f.status : '') + (f.archived ? ' · archived' : '');
    tr.append(cell(f.severity.toUpperCase(), 'sev-' + f.severity), cell(f.label), cell(where), cell(name), cell(f.excerpt));
    tr.lastChild.style.fontFamily = 'monospace'; tr.lastChild.style.whiteSpace = 'pre-wrap'; tr.lastChild.style.wordBreak = 'break-all';
    if (f.severity === 'critical' || f.severity === 'high') tr.firstChild.style.fontWeight = '700';
    body.append(tr);
  }
}
async function load() {
  try {
    const r = await fetch(endpoint('/api/security')), data = await r.json();
    if (!r.ok) throw Error(data.error || 'Could not load the scan.');
    state.data = data; $('notice').hidden = !data.sync?.error; $('notice').textContent = data.sync?.error || ''; render();
  } catch (e) { $('notice').hidden = false; $('notice').textContent = e.message; }
}
$('scan').onclick = async () => {
  const button = $('scan'); button.disabled = true;
  try {
    const r = await fetch(endpoint('/api/security/refresh'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw Error('Could not start the scan.');
    toast('Scan started. Large projects can take a minute.');
    for (let i = 0; i < 60; i++) { await new Promise(res => setTimeout(res, 2000)); const s = await (await fetch(endpoint('/api/security'))).json(); if (s.sync && !s.sync.syncing) { state.data = s; render(); break; } }
  } catch (e) { toast(e.message); } finally { button.disabled = false; }
};
$('severity').onchange = render; $('hideArchived').onchange = render;
$('project').onchange = () => { state.projectId = $('project').value; load(); };
(async () => {
  try {
    const r = await fetch('./api/security/projects'), data = await r.json();
    for (const p of data.projects) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; $('project').append(o); }
    $('project').querySelector('option[value=""]')?.remove();
    state.projectId = data.defaultProjectId; $('project').value = state.projectId; load();
  } catch (e) { $('notice').hidden = false; $('notice').textContent = e.message; }
})();
