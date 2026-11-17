const $ = id => document.getElementById(id);
const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const WHERE = { 'project-javascript': 'Project JavaScript', 'experiment-code': 'Experiment code', 'page-activation': 'Page activation code', extension: 'Extension', 'published-snippet': 'Published snippet (incl. Project JS)' };
const state = { projectId: '', data: null };
const endpoint = path => '.' + path + '?project_id=' + encodeURIComponent(state.projectId);
function toast(message) { const t = $('toast'); t.textContent = message; t.hidden = false; setTimeout(() => { t.hidden = true; }, 4000); }
function cell(text, className) { const td = document.createElement('td'); td.textContent = text; if (className) td.className = className; return td; }
function render() {
  const d = state.data; if (!d) return;
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
        + (sn.changedSinceLastScan === true ? ' · CHANGED since the previous scan (' + new Date(sn.previousScannedAt).toLocaleString() + '); expected if experiments were published' : sn.changedSinceLastScan === false ? ' · unchanged since the previous scan' : ' · first scan, no baseline yet');
  }
  const min = RANK[$('severity').value], hideArchived = $('hideArchived').checked;
  const rows = d.findings.filter(f => RANK[f.severity] >= min && !(hideArchived && f.archived));
  const body = $('rows'); body.replaceChildren();
  if (!rows.length) { const tr = document.createElement('tr'); tr.append(cell(d.findings.length ? 'No findings at this severity.' : 'No findings. Nothing matched the scan rules.')); tr.firstChild.colSpan = 5; body.append(tr); return; }
  for (const f of rows) {
    const tr = document.createElement('tr');
    const where = (WHERE[f.kind] || f.kind) + (f.variation ? ' · ' + f.variation : '');
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
